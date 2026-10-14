import 'server-only';

import { inflateRawSync } from 'node:zlib';
import { BULK_IMPORT_MAX_FILE_BYTES } from '@/lib/bulkImport';
import { BulkImportFileError } from './errors';

// An .xlsx file is a ZIP container. Before handing it to exceljs (which inflates every
// entry into memory) we read the ZIP directory ourselves, refuse non-xlsx formats and
// macro/ActiveX payloads, and inflate each entry with a hard output bound so a forged
// "small" size can never expand into a zip bomb.

const MAX_ENTRIES = 400;
const MAX_ENTRY_UNCOMPRESSED = 16 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 24 * 1024 * 1024;

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

const SAVE_AS_XLSX = "엑셀에서 '다른 이름으로 저장 → Excel 통합 문서(*.xlsx)'로 저장한 뒤 다시 올려 주세요.";

type ZipEntry = Readonly<{
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  flags: number;
  directoryOffset: number;
}>;

export function assertSafeXlsxContainer(bytes: Uint8Array): void {
  if (bytes.byteLength === 0) {
    throw new BulkImportFileError('INVALID_FILE', '빈 파일이에요. 내용을 적은 엑셀 파일을 올려 주세요.');
  }
  if (bytes.byteLength > BULK_IMPORT_MAX_FILE_BYTES) {
    throw new BulkImportFileError('FILE_TOO_LARGE', '파일이 너무 커요. 2MB 이하의 엑셀 파일을 올려 주세요.');
  }
  if (startsWith(bytes, OLE_MAGIC)) {
    throw new BulkImportFileError('INVALID_FILE',
      `옛 엑셀 형식(.xls)이거나 암호가 걸린 파일이에요. ${SAVE_AS_XLSX}`);
  }
  if (!startsWith(bytes, ZIP_MAGIC)) {
    throw new BulkImportFileError('INVALID_FILE',
      `엑셀(.xlsx) 파일이 아니에요. CSV나 다른 문서 파일은 올릴 수 없어요. ${SAVE_AS_XLSX}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readCentralDirectory(bytes, view);
  const names = new Set(entries.map((entry) => entry.name));
  if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) {
    throw new BulkImportFileError('INVALID_FILE', `엑셀 통합 문서(.xlsx)가 아니에요. ${SAVE_AS_XLSX}`);
  }

  for (const entry of entries) {
    const content = inflateEntry(bytes, view, entry);
    if (entry.name === '[Content_Types].xml') {
      const text = new TextDecoder('utf-8').decode(content);
      if (/macroEnabled|vbaProject/i.test(text)) throw macroError();
      if (!/spreadsheetml/i.test(text)) {
        throw new BulkImportFileError('INVALID_FILE', `엑셀 통합 문서(.xlsx)가 아니에요. ${SAVE_AS_XLSX}`);
      }
    }
  }
}

function readCentralDirectory(bytes: Uint8Array, view: DataView): ZipEntry[] {
  const end = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0
    || entryCount !== view.getUint16(end + 8, true)) throw corrupted();
  if (entryCount === 0 || entryCount === 0xffff || directoryOffset === 0xffffffff) throw corrupted();
  if (entryCount > MAX_ENTRIES) throw tooLarge();
  if (directorySize === 0xffffffff || directoryOffset + directorySize !== end) throw corrupted();

  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  let total = 0;
  let pointer = directoryOffset;
  const names = new Set<string>();
  const offsets = new Set<number>();
  for (let index = 0; index < entryCount; index += 1) {
    if (pointer + 46 > end || view.getUint32(pointer, true) !== CENTRAL_HEADER) throw corrupted();
    const flags = view.getUint16(pointer + 8, true);
    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const size = view.getUint32(pointer + 24, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    if (pointer + 46 + nameLength + extraLength + commentLength > end) throw corrupted();
    const name = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));

    if (!name || names.has(name) || offsets.has(localOffset) || view.getUint16(pointer + 34, true) !== 0) throw corrupted();
    names.add(name);
    offsets.add(localOffset);

    if (flags & 0x1) {
      throw new BulkImportFileError('INVALID_FILE', `암호가 걸린 파일은 열 수 없어요. 암호를 풀고 ${SAVE_AS_XLSX}`);
    }
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw corrupted();
    if (method !== 0 && method !== 8) throw corrupted();
    if (isMacroEntry(name)) throw macroError();
    if (size > MAX_ENTRY_UNCOMPRESSED) throw tooLarge();
    total += size;
    if (total > MAX_TOTAL_UNCOMPRESSED) throw tooLarge();

    entries.push({ name, method, compressedSize, size, localOffset, flags, directoryOffset });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  if (pointer !== end) throw corrupted();
  return entries;
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - (22 + 0xffff));
  // JSZip uses the raw last signature. Never skip a later inconsistent record
  // and validate a different directory from the downstream workbook parser.
  for (let offset = view.byteLength - 4; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY) continue;
    if (offset + 22 > view.byteLength
      || offset + 22 + view.getUint16(offset + 20, true) !== view.byteLength) throw corrupted();
    return offset;
  }
  throw corrupted();
}

function inflateEntry(bytes: Uint8Array, view: DataView, entry: ZipEntry): Uint8Array {
  const local = entry.localOffset;
  if (local + 30 > entry.directoryOffset || view.getUint32(local, true) !== LOCAL_HEADER) throw corrupted();
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const finish = start + entry.compressedSize;
  if (start > entry.directoryOffset || finish > entry.directoryOffset
    || view.getUint16(local + 6, true) !== entry.flags
    || view.getUint16(local + 8, true) !== entry.method
    || new TextDecoder('utf-8').decode(bytes.subarray(local + 30, local + 30 + view.getUint16(local + 26, true))) !== entry.name) throw corrupted();
  const data = bytes.subarray(start, finish);
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw corrupted();
    return data;
  }
  let output: Uint8Array;
  try {
    // maxOutputLength makes zlib throw as soon as the real output exceeds the declared size.
    output = inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) });
  } catch {
    throw corrupted();
  }
  if (output.byteLength !== entry.size) throw corrupted();
  return output;
}

function isMacroEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return /(^|\/)vbaproject\.bin$/.test(lower) || /(^|\/)vbaprojectsignature/.test(lower)
    || lower.startsWith('xl/activex/') || lower.startsWith('xl/macrosheets/');
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.byteLength >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

function corrupted(): BulkImportFileError {
  return new BulkImportFileError('INVALID_FILE', `엑셀 파일이 손상되었거나 열 수 없는 형식이에요. ${SAVE_AS_XLSX}`);
}

function tooLarge(): BulkImportFileError {
  return new BulkImportFileError('FILE_TOO_LARGE', '파일 내용이 너무 커요. 양식에 학생, 상품 목록만 남기고 다시 올려 주세요.');
}

function macroError(): BulkImportFileError {
  return new BulkImportFileError('INVALID_FILE',
    `매크로나 ActiveX가 들어 있는 파일은 올릴 수 없어요. ${SAVE_AS_XLSX}`);
}
