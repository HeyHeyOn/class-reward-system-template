import { projectPreflightReport, type PreflightReportProjectionResult } from './preflightReportProjection';

export type HistoricalReportDownloadResult =
  | Readonly<{
    kind: 'HISTORICAL_REPORT_DOWNLOAD';
    filename: string;
    mediaType: 'application/json';
    encoding: 'utf-8';
    body: string;
  }>
  | Extract<PreflightReportProjectionResult, { kind: 'UNAVAILABLE' }>;

/** Pure historical file descriptor, NOT a route, download, authorization or
 * migration capability. No data is acquired, saved, served or regenerated here.
 *
 * The future caller must use a currently authorized, bounded reader and bound
 * transport bytes BEFORE decoding the envelope. Supply the exact independent
 * { tenantId, migrationJobId, reportId } selection, not a caller-claimed DTO.
 * The projector alone admits the graph/schema/digest and constructs the body.
 *
 * Success proves only unkeyed archival integrity, not original source binding,
 * freshness, writer exclusion, current preflight, activation or cutover. This
 * is not a source backup, rollback artifact or operational export. Every such
 * historical/non-authority qualifier remains in the JSON, even for MATCHED.
 *
 * Byte contract: UTF-8 encode body as compact JSON followed by one LF, no BOM.
 * Property order comes from the new projection, not input key insertion order.
 */
export function formatHistoricalReportDownload(envelope: unknown, selection: unknown): HistoricalReportDownloadResult {
  const result = projectPreflightReport(envelope, selection);
  if (result.kind !== 'HISTORICAL_REPORT') return result;

  // Only the admitted lowercase digest enters the name; never tenant/job/source
  // text, a caller filename, a random value or the current clock.
  const digest = result.projection.reportId.slice('reconciliation:'.length);
  return {
    kind: 'HISTORICAL_REPORT_DOWNLOAD',
    filename: `historical-preflight-${digest}.json`,
    mediaType: 'application/json', encoding: 'utf-8',
    body: `${JSON.stringify(result.projection)}\n`,
  };
}
