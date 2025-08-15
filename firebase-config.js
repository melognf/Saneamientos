// firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// 👉 Pegá acá tu config real del proyecto que estás usando
const firebaseConfig = {
  apiKey: "AIzaSyCZNpPfYCeYtGt2TlGQJz0gazjyIoGlPpM",
  authDomain: "saneamiento2-31737.firebaseapp.com",
  projectId: "saneamiento2-31737",
  storageBucket: "saneamiento2-31737.firebasestorage.app",
  messagingSenderId: "1086121183006",
  appId: "1:1086121183006:web:40bf8dd265256799faab0f"
};

export const app  = initializeApp(firebaseConfig);
export const db   = getFirestore(app);
export const auth = getAuth(app);

// Muestra el projectId en pantalla para verificar que apuntas al proyecto correcto
window.__FIREBASE_PROJECT_ID__ = firebaseConfig.projectId;
