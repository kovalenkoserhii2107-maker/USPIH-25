// firebase-firestore для демо-будинку: читання й запис — у базу цієї вкладки.
import { store } from './runtime.js';
const api = store.client;
export const { getFirestore, initializeFirestore, doc, collection, collectionGroup, query, where, orderBy, limit, limitToLast, startAfter, and, documentId,
    serverTimestamp, deleteField, increment, arrayUnion, arrayRemove, Timestamp, getDoc, getDocs, getDocFromServer, getDocsFromServer, getDocFromCache, getDocsFromCache,
    getCountFromServer, setDoc, updateDoc, addDoc, deleteDoc, writeBatch, runTransaction, onSnapshot, enableNetwork, disableNetwork,
    enableIndexedDbPersistence, persistentLocalCache, persistentMultipleTabManager } = api;
