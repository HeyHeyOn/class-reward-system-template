import 'server-only';

/** Legacy adapters are loaded only after storage selection invokes a Sheets operation.
 * PostgreSQL composition must not evaluate the Sheets SDK or historical writers.
 * Keep these typed forwarders stateless: reader/store caches remain request-scoped. */

export const createConfiguredSheetsStore: typeof import('@/server/googleSheets').createConfiguredSheetsStore = async (...args) =>
  (await import('@/server/googleSheets')).createConfiguredSheetsStore(...args);

export const bulkAdjustStudentBalances: typeof import('@/server/sheetsRepository').bulkAdjustStudentBalances = async (...args) =>
  (await import('@/server/sheetsRepository')).bulkAdjustStudentBalances(...args);

export const createConfiguredSheetsReader: typeof import('@/server/googleSheets').createConfiguredSheetsReader = async (...args) =>
  (await import('@/server/googleSheets')).createConfiguredSheetsReader(...args);

export const getStudentById: typeof import('@/server/sheetsRepository').getStudentById = async (...args) =>
  (await import('@/server/sheetsRepository')).getStudentById(...args);

export const getTransactions: typeof import('@/server/sheetsRepository').getTransactions = async (...args) =>
  (await import('@/server/sheetsRepository')).getTransactions(...args);

export const getActivePromotions: typeof import('@/server/repositories/sheets/promotionQueries').getActivePromotions = async (...args) =>
  (await import('@/server/repositories/sheets/promotionQueries')).getActivePromotions(...args);

export const getPromotions: typeof import('@/server/repositories/sheets/promotionQueries').getPromotions = async (...args) =>
  (await import('@/server/repositories/sheets/promotionQueries')).getPromotions(...args);

export const getActiveProducts: typeof import('@/server/sheetsRepository').getActiveProducts = async (...args) =>
  (await import('@/server/sheetsRepository')).getActiveProducts(...args);

export const getProducts: typeof import('@/server/sheetsRepository').getProducts = async (...args) =>
  (await import('@/server/sheetsRepository')).getProducts(...args);

export const createSheetsCheckoutCommand: typeof import('@/server/checkoutService').createSheetsCheckoutCommand = (store) => ({
  async execute(input) {
    return (await import('@/server/checkoutService')).createSheetsCheckoutCommand(store).execute(input);
  },
});

export const previewCheckoutCart: typeof import('@/server/checkoutService').previewCheckoutCart = async (...args) =>
  (await import('@/server/checkoutService')).previewCheckoutCart(...args);

export const createProduct: typeof import('@/server/sheetsRepository').createProduct = async (...args) =>
  (await import('@/server/sheetsRepository')).createProduct(...args);

export const deleteProduct: typeof import('@/server/sheetsRepository').deleteProduct = async (...args) =>
  (await import('@/server/sheetsRepository')).deleteProduct(...args);

export const updateProductDetailsBatch: typeof import('@/server/sheetsRepository').updateProductDetailsBatch = async (...args) =>
  (await import('@/server/sheetsRepository')).updateProductDetailsBatch(...args);

export const createPromotion: typeof import('@/server/repositories/sheets/promotionCommands').createPromotion = async (...args) =>
  (await import('@/server/repositories/sheets/promotionCommands')).createPromotion(...args);

export const replacePromotionProducts: typeof import('@/server/repositories/sheets/promotionCommands').replacePromotionProducts = async (...args) =>
  (await import('@/server/repositories/sheets/promotionCommands')).replacePromotionProducts(...args);

export const deletePromotion: typeof import('@/server/repositories/sheets/promotionCommands').deletePromotion = async (...args) =>
  (await import('@/server/repositories/sheets/promotionCommands')).deletePromotion(...args);

export const setPromotionActive: typeof import('@/server/repositories/sheets/promotionCommands').setPromotionActive = async (...args) =>
  (await import('@/server/repositories/sheets/promotionCommands')).setPromotionActive(...args);

export const updatePromotion: typeof import('@/server/repositories/sheets/promotionCommands').updatePromotion = async (...args) =>
  (await import('@/server/repositories/sheets/promotionCommands')).updatePromotion(...args);

export const createStudent: typeof import('@/server/sheetsRepository').createStudent = async (...args) =>
  (await import('@/server/sheetsRepository')).createStudent(...args);

export const deleteStudent: typeof import('@/server/sheetsRepository').deleteStudent = async (...args) =>
  (await import('@/server/sheetsRepository')).deleteStudent(...args);

export const deleteStudentsBatch: typeof import('@/server/sheetsRepository').deleteStudentsBatch = async (...args) =>
  (await import('@/server/sheetsRepository')).deleteStudentsBatch(...args);

export const updateStudentDetailsBatchWithBalanceTransactions: typeof import('@/server/sheetsRepository').updateStudentDetailsBatchWithBalanceTransactions = async (...args) =>
  (await import('@/server/sheetsRepository')).updateStudentDetailsBatchWithBalanceTransactions(...args);

export const getStudents: typeof import('@/server/sheetsRepository').getStudents = async (...args) =>
  (await import('@/server/sheetsRepository')).getStudents(...args);

export const listTaskCycleProjections: typeof import('@/server/repositories/sheets/taskHistoryQueries').listTaskCycleProjections = async (...args) =>
  (await import('@/server/repositories/sheets/taskHistoryQueries')).listTaskCycleProjections(...args);

export const completeTaskForStudent: typeof import('@/server/sheetsRepository').completeTaskForStudent = async (...args) =>
  (await import('@/server/sheetsRepository')).completeTaskForStudent(...args);

export const createTask: typeof import('@/server/sheetsRepository').createTask = async (...args) =>
  (await import('@/server/sheetsRepository')).createTask(...args);

export const resetTaskCompletionsBatch: typeof import('@/server/sheetsRepository').resetTaskCompletionsBatch = async (...args) =>
  (await import('@/server/sheetsRepository')).resetTaskCompletionsBatch(...args);

export const getTaskAssignmentStatus: typeof import('@/server/sheetsRepository').getTaskAssignmentStatus = async (...args) =>
  (await import('@/server/sheetsRepository')).getTaskAssignmentStatus(...args);

export const getTaskById: typeof import('@/server/sheetsRepository').getTaskById = async (...args) =>
  (await import('@/server/sheetsRepository')).getTaskById(...args);

export const getTasks: typeof import('@/server/sheetsRepository').getTasks = async (...args) =>
  (await import('@/server/sheetsRepository')).getTasks(...args);

export const getTaskCycleProjection: typeof import('@/server/repositories/sheets/taskHistoryQueries').getTaskCycleProjection = async (...args) =>
  (await import('@/server/repositories/sheets/taskHistoryQueries')).getTaskCycleProjection(...args);

export const getTaskHistoryDetail: typeof import('@/server/repositories/sheets/taskHistoryQueries').getTaskHistoryDetail = async (...args) =>
  (await import('@/server/repositories/sheets/taskHistoryQueries')).getTaskHistoryDetail(...args);

export const cancelTransaction: typeof import('@/server/sheetsRepository').cancelTransaction = async (...args) =>
  (await import('@/server/sheetsRepository')).cancelTransaction(...args);
