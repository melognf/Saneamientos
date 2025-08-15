// firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDY7UmGpp4-JE6Ax00G2Sed1lMRqd079JI",
  authDomain: "saneamientos-f3e83.firebaseapp.com",
  projectId: "saneamientos-f3e83",
  storageBucket: "saneamientos-f3e83.firebasestorage.app",
  messagingSenderId: "763641380153",
  appId: "1:763641380153:web:f330b8a8c9317faf897ce8"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
