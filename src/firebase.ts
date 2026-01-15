import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// Cấu hình Firebase (Chìa khóa của bạn)
const firebaseConfig = {
  apiKey: "AIzaSyB379E6FeFdVchfVZOOg67zXpfHA2NFo-4",
  authDomain: "smartfin-24c3d.firebaseapp.com",
  projectId: "smartfin-24c3d",
  storageBucket: "smartfin-24c3d.firebasestorage.app",
  messagingSenderId: "599729173786",
  appId: "1:599729173786:web:b386a533d5c3df7cc528a3",
  measurementId: "G-SB8SVRHMQ2"
};

// Khởi tạo và xuất ra để dùng
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);