const DB_NAME = "drawing-automation-equipment";
const STORE_NAME = "drawings";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, {keyPath: "id"})
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error)
  })
}

function useStore(mode, operation) {
  return openDatabase().then(database => new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    let result;
    request.onsuccess = () => {
      result = request.result
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => {
      database.close();
      resolve(result)
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error)
    }
  }))
}

export const getDrawings = () => useStore("readonly", store => store.getAll());
export const saveDrawing = drawing => useStore("readwrite", store => store.put(drawing));
export const removeDrawing = id => useStore("readwrite", store => store.delete(id));
