const DB_NAME = "drawing-automation-equipment";
const STORE_NAME = "drawings";

/**
 * 등록 도면은 대용량 File 객체와 분석 결과를 함께 저장해야 하므로 localStorage 대신
 * 구조화 복제와 Blob 저장을 지원하는 IndexedDB를 사용한다.
 */
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
  // request 성공 시점과 실제 transaction commit 시점은 다르다. 새로고침 직전에
  // 분석 결과가 유실되지 않도록 transaction.oncomplete에서만 Promise를 완료한다.
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
