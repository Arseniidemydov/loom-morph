import type { LeadRecord } from '@/types';

// Final report — one row per lead. Columns chosen to be useful for "manually
// retry these failed leads" workflows.
export function formatReportCsv(leads: LeadRecord[]): string {
  const header = ['row_index', 'website', 'status', 'output_path', 'capture_ms', 'render_ms', 'error'];
  const lines = [header.join(',')];
  for (const lead of leads) {
    lines.push(
      [
        String(lead.rowIndex),
        csvEscape(lead.website),
        lead.status,
        csvEscape(lead.outputPath ?? ''),
        lead.captureMs?.toString() ?? '',
        lead.renderMs?.toString() ?? '',
        csvEscape(lead.error ?? ''),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

function csvEscape(value: string): string {
  if (value === '') return '';
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
