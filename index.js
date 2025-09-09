const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Translate } = require('@google-cloud/translate').v2;
const admin = require('firebase-admin');
require('dotenv').config();

// Initialize Firebase Admin SDK
// You must get a Firebase service account key JSON file and place it in your project root
// You can download this from Project Settings -> Service Accounts
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Initialize other modules
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const translate = new Translate({
  key: process.env.GOOGLE_TRANSLATE_API_KEY
});

const PORT = process.env.PORT || 3001;

// Store active users and their language preferences
const activeUsers = {};

// Helper function to get chat history
async function getChatHistory(chatId) {
  if (!chatId) {
    console.error("getChatHistory called with an invalid chatId:", chatId);
    return [];
  }
  const messagesRef = db.collection('chats').doc(chatId).collection('messages');
  const snapshot = await messagesRef.orderBy('timestamp', 'asc').get();
  const messages = [];
  snapshot.forEach(doc => {
    messages.push(doc.data());
  });
  return messages;
}

io.on('connection', (socket) => {
  console.log(`A user connected with socket ID: ${socket.id}`);

  // When a user joins, they provide their chat ID and preferred language
  socket.on('joinChat', async (data) => {
    const { chatId, preferredLanguage, senderName } = data;
    
    // Crucial check to prevent crashing with undefined data
    if (!chatId || !preferredLanguage || !senderName) {
      console.error(`Received invalid joinChat data. Chat ID: ${chatId}, Language: ${preferredLanguage}, Sender: ${senderName}`);
      return;
    }
    
    // Store user's language preference and their socket ID
    activeUsers[socket.id] = { chatId, preferredLanguage, senderName };

    // Have the user join the specific chat room
    socket.join(chatId);
    console.log(`${senderName} (${socket.id}) joined chat room: ${chatId} with lang: ${preferredLanguage}`);
    
    // Send back the chat history to the newly connected user
    const chatHistory = await getChatHistory(chatId);
    if (chatHistory.length > 0) {
      // For each message, translate it to the new user's language before sending
      const translatedHistory = await Promise.all(chatHistory.map(async msg => {
        try {
          const [translation] = await translate.translate(msg.originalText, preferredLanguage);
          return { ...msg, translatedText: translation };
        } catch (error) {
          console.error("Error translating history message:", error);
          return { ...msg, translatedText: "Translation error." };
        }
      }));
      socket.emit('chatHistory', translatedHistory);
    }
  });

  // When a user sends a new message
  socket.on('sendMessage', async (data) => {
    const { text, chatId, senderName } = data;
    console.log(`New message from ${senderName} in chat ${chatId}: ${text}`);

    const message = {
      sender: senderName,
      originalText: text,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      chatId: chatId,
    };

    // Save the message to Firestore first
    await db.collection('chats').doc(chatId).collection('messages').add(message);
    
    // Get all users in the chat room to send personalized translations
    const chatRoomSockets = await io.in(chatId).fetchSockets();

    chatRoomSockets.forEach(async clientSocket => {
      const user = activeUsers[clientSocket.id];
      if (user) {
        let translatedText;
        try {
          // Translate the message to EACH user's preferred language
          const [translation] = await translate.translate(text, user.preferredLanguage);
          translatedText = translation;
        } catch (error) {
          console.error("Error translating message:", error);
          translatedText = "Translation error.";
        }
        
        // Construct the personalized message object
        const personalizedMessage = {
          sender: senderName,
          originalText: text,
          translatedText: translatedText,
          timestamp: new Date().toISOString(),
          chatId: chatId,
        };

        // Send the personalized message to the individual client
        clientSocket.emit('receiveMessage', personalizedMessage);
      }
    });
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected with socket ID: ${socket.id}`);
    delete activeUsers[socket.id];
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
