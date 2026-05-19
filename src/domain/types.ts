export type StudentStatus = 'ACTIVE' | 'INACTIVE';

export type Student = {
  studentId: string;
  name: string;
  number: number;
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
