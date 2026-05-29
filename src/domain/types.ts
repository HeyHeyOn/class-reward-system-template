export type StudentStatus = 'ACTIVE' | 'INACTIVE';

export type Student = {
  studentId: string;
  name: string;
  balance: number;
  status: StudentStatus;
};

export type Product = {
  productId: string;
  name: string;
  price: number;
  stock: number;
  isActive: boolean;
  imageUrl?: string;
  category?: string;
  sortOrder: number;
};

export type CartItem = {
  productId: string;
  quantity: number;
};

export type CheckoutLineItem = {
  productId: string;
  name: string;
  price: number;
  quantity: number;
  subtotal: number;
};

export type Transaction = {
  transactionId: string;
  timestamp: string;
  studentId: string;
  studentName: string;
  items: CheckoutLineItem[];
  totalAmount: number;
  balanceBefore: number;
  balanceAfter: number;
  status: string;
  operator: string;
  cancelledAt?: string;
};

export type ClassTask = {
  taskId: string;
  title: string;
  description: string;
  reward: number;
  maxCompletionsPerStudent: number;
  isActive: boolean;
  sortOrder: number;
  allowedStudentIds: string[];
  createdAt?: string;
};

export type TaskCompletion = {
  completionId: string;
  timestamp: string;
  taskId: string;
  studentId: string;
  studentName: string;
  reward: number;
  balanceBefore: number;
  balanceAfter: number;
  status: string;
  note: string;
};
