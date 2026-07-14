// firebase.js (a classic script loaded before this module) initializes the
// Firebase app and defines `db` and `firebaseConfig` as top-level bindings.
// Classic-script top-level const/let live in the global scope that modules
// share, so re-export them here to make the dependency explicit.
const database = db;
const config = firebaseConfig;
export { database as db, config as firebaseConfig };
