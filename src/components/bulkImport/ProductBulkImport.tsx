'use client';

import { Badge } from '@/components/ui';
import {
  parseProductImportCommitResult,
  parseProductImportPreview,
  type ProductImportCreated,
  type ProductImportRow,
} from '@/lib/bulkImport';
import { BulkImportControls, formatAmount, type BulkImportConfig, type BulkImportControlsProps } from './BulkImportControls';

const PRODUCT_IMPORT: BulkImportConfig<ProductImportRow, ProductImportCreated> = {
  noun: '상품',
  countLabel: (count) => `${count}개`,
  successMessage: (count) => `상품 ${count}개를 추가했어요`,
  templatePath: '/api/products/import/template',
  previewPath: '/api/products/import/preview',
  commitPath: '/api/products/import/commit',
  templateFileName: '매점 상품 양식.xlsx',
  parsePreview: parseProductImportPreview,
  parseCommit: parseProductImportCommitResult,
  columns: (unit) => [
    { label: '상품 이름', render: (row) => <span className="font-bold">{row.name}</span> },
    { label: '가격', align: 'right', render: (row) => formatAmount(row.price, unit) },
    { label: '재고', align: 'right', render: (row) => `${row.stock.toLocaleString('ko-KR')}개` },
    { label: '분류', render: (row) => row.category ?? <span className="text-[var(--theme-muted-text)]">-</span> },
    { label: '순서', align: 'right', render: (row) => row.sortOrder },
    {
      label: '판매',
      render: (row) => row.isActive ? <Badge tone="success" dot>판매</Badge> : <Badge>숨김</Badge>,
    },
  ],
};

/** 매점 tab header controls: 양식 다운로드 + 엑셀로 일괄 추가 (preview → confirm dialog). */
export function ProductBulkImport(props: BulkImportControlsProps) {
  return <BulkImportControls config={PRODUCT_IMPORT} {...props} />;
}
