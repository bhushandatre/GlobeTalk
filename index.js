const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { Translate } = require('@google-cloud/translate').v2;
const admin = require('firebase-admin');
require('dotenv').config();

// Firebase Admin Setup
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Express + Socket.io Setup
const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const translate = new Translate({ key: process.env.GOOGLE_TRANSLATE_API_KEY });
const PORT = process.env.PORT || 3001;

const activeUsers = {}; // socket.id -> { chatId, lang, sender }

// Helper: Get chat history
async function getChatHistory(chatId) {
  const messagesRef = db.collection('chats').doc(chatId).collection('messages');
  const snapshot = await messagesRef.orderBy('timestamp', 'asc').get();
  const messages = [];
  snapshot.forEach(doc => messages.push(doc.data()));
  return messages;
}

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on('joinChat', async (data) => {
    const { chatId, preferredLanguage, senderName } = data;
    if (!chatId || !preferredLanguage || !senderName) return;

    activeUsers[socket.id] = { chatId, preferredLanguage, senderName };
    socket.join(chatId);
    console.log(`${senderName} joined chat ${chatId}`);

    const chatHistory = await getChatHistory(chatId);
    const translatedHistory = await Promise.all(
      chatHistory.map(async (msg) => {
        try {
          const [translatedText] = await translate.translate(msg.originalText, preferredLanguage);
          return { ...msg, translatedText };
        } catch {
          return { ...msg, translatedText: "[translation failed]" };
        }
      })
    );

    socket.emit('chatHistory', translatedHistory);
  });

  socket.on('sendMessage', async (data) => {
    const { text, chatId, senderName } = data;
    if (!text || !chatId) return;

    const message = {
      sender: senderName,
      originalText: text,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('chats').doc(chatId).collection('messages').add(message);
    await db.collection('chats').doc(chatId).set(
      { lastMessage: text, updatedAt: new Date() },
      { merge: true }
    );

    const sockets = await io.in(chatId).fetchSockets();
    for (const client of sockets) {
      const user = activeUsers[client.id];
      if (!user) continue;

      try {
        const [translatedText] = await translate.translate(text, user.preferredLanguage);
        client.emit('receiveMessage', {
          sender: senderName,
          originalText: text,
          translatedText,
          timestamp: new Date().toISOString()
        });
      } catch {
        client.emit('receiveMessage', {
          sender: senderName,
          originalText: text,
          translatedText: "[translation failed]"
        });
      }
    }
  });

  socket.on('disconnect', () => {
    delete activeUsers[socket.id];
  });
});

server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

