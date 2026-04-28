'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import type {
  BatchEvent,
  CaptureMode,
  CirclePosition,
  CircleSize,
  LeadStatus,
  Resolution,
} from '@/types';
import { normalizeWebsite } from '@/lib/url';

type CsvRow = Record<string, string>;

interface StartBatchResponse {
  batchId: string;
  total: number;
  skipped: number;
  websiteColumn: string;
  eventsUrl: string;
  reportUrl: string;
  archiveUrl: string;
  error?: string;
}

type BatchErrorEvent = { type: 'batch-error'; error: string };
type CircleSourceMode = 'image' | 'video';

interface CsvDataset {
  fileName: string;
  rows: CsvRow[];
  columns: string[];
  errorCount: number;
}

interface LeadPreview {
  id: string;
  rowIndex: number;
  website: string;
  company: string;
  status: LeadStatus;
  progress: number;
  outputPath?: string;
  error?: string;
}

const SAMPLE_LEADS: LeadPreview[] = [
  {
    id: 'sample-1',
    rowIndex: 0,
    website: 'https://acme.example',
    company: 'Acme',
    status: 'pending',
    progress: 0,
  },
  {
    id: 'sample-2',
    rowIndex: 1,
    website: 'https://northwind.example',
    company: 'Northwind',
    status: 'pending',
    progress: 0,
  },
  {
    id: 'sample-3',
    rowIndex: 2,
    website: 'https://globex.example',
    company: 'Globex',
    status: 'pending',
    progress: 0,
  },
];

// Dev-time defaults so the page lands ready-to-run. Files live under
// public/test-assets/ and are served as static URLs by Next.
const PREFILL = {
  csv: '/test-assets/leads.csv',
  csvName: 'leads.csv',
  circleImage: '/test-assets/circle.png',
  circleImageName: 'circle.png',
  circleVideo: '/test-assets/circle.mp4',
  circleVideoName: 'circle.mp4',
  audioName: 'narration.mp3',
} as const;

const MAX_BATCH_LEADS = 3;

const SIZE_LABELS: Record<CircleSize, string> = {
  S: '200 px',
  M: '280 px',
  L: '360 px',
};

const BUBBLE_PREVIEW: Record<CircleSize, string> = {
  S: '72px',
  M: '92px',
  L: '112px',
};

const CIRCLE_ACCEPT: Record<CircleSourceMode, string> = {
  image: 'image/png,image/jpeg',
  video: 'video/mp4,video/quicktime,video/webm,video/x-matroska',
};

const CIRCLE_PREFILL: Record<CircleSourceMode, { url: string; name: string; type: string }> = {
  image: {
    url: PREFILL.circleImage,
    name: PREFILL.circleImageName,
    type: 'image/png',
  },
  video: {
    url: PREFILL.circleVideo,
    name: PREFILL.circleVideoName,
    type: 'video/mp4',
  },
};

export function BatchWorkbench() {
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [circleFile, setCircleFile] = useState<File | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [circleMode, setCircleMode] = useState<CircleSourceMode>('image');
  const [circleHasAudio, setCircleHasAudio] = useState(true);
  const [circlePreviewUrl, setCirclePreviewUrl] = useState('');
  const [circleCropScale, setCircleCropScale] = useState(1);
  const [circleCropX, setCircleCropX] = useState(0);
  const [circleCropY, setCircleCropY] = useState(0);
  const [csvFileName, setCsvFileName] = useState('');
  const [circleFileName, setCircleFileName] = useState('');
  const [audioFileName, setAudioFileName] = useState('');
  const [csvDataset, setCsvDataset] = useState<CsvDataset | null>(null);
  const [websiteColumn, setWebsiteColumn] = useState('');
  const [companyColumn, setCompanyColumn] = useState('');
  const [leads, setLeads] = useState<LeadPreview[]>(SAMPLE_LEADS);
  const [parseMessage, setParseMessage] = useState('Sample batch loaded');
  const [prospectLimit, setProspectLimit] = useState(MAX_BATCH_LEADS);
  const [durationSec, setDurationSec] = useState(30);
  const [resolution, setResolution] = useState<Resolution>('720p');
  // 'screenshot' (fast, parallelizable) vs 'recording' (real motion;
  // needed for sites with hero videos / parallax). See D-019.
  const [captureMode, setCaptureMode] = useState<CaptureMode>('screenshot');
  const [circleSize, setCircleSize] = useState<CircleSize>('M');
  const [circlePosition, setCirclePosition] =
    useState<CirclePosition>('bottom-right');
  const [filenameTemplate, setFilenameTemplate] = useState('{company}.mp4');
  const [isRunning, setIsRunning] = useState(false);
  const [batchId, setBatchId] = useState('');
  const [reportUrl, setReportUrl] = useState('');
  const [archiveUrl, setArchiveUrl] = useState('');
  const [runError, setRunError] = useState('');
  const [previewWebsite, setPreviewWebsite] = useState(SAMPLE_LEADS[0]?.website ?? '');
  const previewWebsiteTouchedRef = useRef(false);
  const userSelectedCircleRef = useRef(false);
  const circleLoadRequestRef = useRef(0);

  const summary = useMemo(() => {
    const done = leads.filter((lead) => lead.status === 'done').length;
    const failed = leads.filter((lead) => lead.status === 'failed').length;
    const active = leads.filter(
      (lead) => lead.status === 'capturing' || lead.status === 'rendering',
    ).length;
    const totalProgress =
      leads.length === 0
        ? 0
        : Math.round(
            leads.reduce((sum, lead) => sum + lead.progress, 0) / leads.length,
          );

    return { done, failed, active, processed: done + failed, totalProgress };
  }, [leads]);

  const websiteColumnStats = useMemo(() => {
    if (!csvDataset || !websiteColumn) return null;

    let usable = 0;
    const rejected: string[] = [];
    for (const row of csvDataset.rows) {
      const raw = (row[websiteColumn] ?? '').trim();
      if (!raw) continue;
      if (normalizeWebsite(raw)) {
        usable += 1;
      } else if (rejected.length < 3) {
        rejected.push(raw);
      }
    }

    return {
      queued: Math.min(usable, prospectLimit, MAX_BATCH_LEADS),
      usable,
      rejected,
    };
  }, [csvDataset, prospectLimit, websiteColumn]);

  const availableProspectCount = websiteColumnStats?.usable ?? leads.length;
  const maxProspectLimit = Math.max(
    1,
    Math.min(availableProspectCount || MAX_BATCH_LEADS, MAX_BATCH_LEADS),
  );

  const normalizedPreviewWebsite = useMemo(
    () => normalizeWebsite(previewWebsite) ?? '',
    [previewWebsite],
  );

  useEffect(() => {
    if (!circleFile) {
      setCirclePreviewUrl('');
      return;
    }

    const url = URL.createObjectURL(circleFile);
    setCirclePreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [circleFile]);

  // Auto-load test assets on first mount so the page is immediately usable
  // for dev work. The user can still upload new files via the inputs to
  // override.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch(PREFILL.csv);
        if (!resp.ok) throw new Error(`fetch ${PREFILL.csv} → ${resp.status}`);
        const csvBlob = await resp.blob();
        const text = await csvBlob.text();
        const audioResp = await fetch('/test-assets/narration.mp3');
        if (cancelled) return;

        const parsed = Papa.parse<CsvRow>(text, {
          header: true,
          skipEmptyLines: 'greedy',
          transformHeader: cleanCsvHeader,
          transform: (value) => value.trim(),
        });
        const columns = (parsed.meta.fields ?? []).filter(Boolean);
        const inferredWebsite = inferColumn(columns, isWebsiteHeader);
        const inferredCompany = inferColumn(columns, isCompanyHeader);

        if (cancelled) return;
        setCsvFile(new File([csvBlob], PREFILL.csvName, { type: 'text/csv' }));
        const circleResp = await fetch(CIRCLE_PREFILL.image.url);
        if (circleResp.ok && !cancelled && !userSelectedCircleRef.current) {
          setCircleMode('image');
          setCircleHasAudio(false);
          setCircleFile(
            new File([await circleResp.blob()], CIRCLE_PREFILL.image.name, {
              type: CIRCLE_PREFILL.image.type,
            }),
          );
          setCircleFileName(CIRCLE_PREFILL.image.name);
        }
        if (audioResp.ok) {
          setAudioFile(
            new File([await audioResp.blob()], PREFILL.audioName, {
              type: 'audio/mpeg',
            }),
          );
        }
        setWebsiteColumn(inferredWebsite);
        setCompanyColumn(inferredCompany);
        setCsvDataset({
          fileName: PREFILL.csvName,
          rows: parsed.data,
          columns,
          errorCount: parsed.errors.length,
        });
        setCsvFileName(PREFILL.csvName);
        setAudioFileName(PREFILL.audioName);
      } catch (err) {
        if (cancelled) return;
        // Silent fallback: leave SAMPLE_LEADS in place. Dev convenience only.
        // eslint-disable-next-line no-console
        console.warn('[workbench] prefill skipped:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!csvDataset) return;

    const parsedLeads = buildLeadPreview(
      csvDataset.rows,
      websiteColumn,
      companyColumn,
      prospectLimit,
    );

    setLeads(parsedLeads);
    setParseMessage(
      csvParseMessage({
        fileName: csvDataset.fileName,
        leadCount: parsedLeads.length,
        errorCount: csvDataset.errorCount,
        hasColumns: csvDataset.columns.length > 0,
        websiteColumn,
      }),
    );
  }, [companyColumn, csvDataset, prospectLimit, websiteColumn]);

  useEffect(() => {
    if (prospectLimit > maxProspectLimit) setProspectLimit(maxProspectLimit);
  }, [maxProspectLimit, prospectLimit]);

  useEffect(() => {
    if (previewWebsiteTouchedRef.current) return;
    setPreviewWebsite(leads[0]?.website ?? '');
  }, [leads]);

  function handleCsv(file: File | undefined) {
    if (!file) return;
    setCsvFile(file);
    setCsvFileName(file.name);
    setIsRunning(false);
    setBatchId('');
    setReportUrl('');
    setArchiveUrl('');
    setRunError('');

    void file
      .text()
      .then((text) => {
        const parsed = Papa.parse<CsvRow>(text, {
          header: true,
          skipEmptyLines: 'greedy',
          transformHeader: cleanCsvHeader,
          transform: (value) => value.trim(),
        });

        const columns = (parsed.meta.fields ?? []).filter(Boolean);
        const inferredWebsite = inferColumn(columns, isWebsiteHeader);
        const inferredCompany = inferColumn(columns, isCompanyHeader);

        setWebsiteColumn(inferredWebsite);
        setCompanyColumn(inferredCompany);
        setCsvDataset({
          fileName: file.name,
          rows: parsed.data,
          columns,
          errorCount: parsed.errors.length,
        });
      })
      .catch(() => {
        setCsvDataset(null);
        setWebsiteColumn('');
        setCompanyColumn('');
        setLeads([]);
        setParseMessage(`Could not read ${file.name}`);
      });
  }

  function resetRun() {
    setIsRunning(false);
    setBatchId('');
    setReportUrl('');
    setArchiveUrl('');
    setRunError('');
    setLeads((current) =>
      current.map((lead) => ({
        ...lead,
        status: 'pending',
        progress: 0,
        outputPath: undefined,
        error: undefined,
      })),
    );
  }

  function clearRunResult() {
    setIsRunning(false);
    setBatchId('');
    setReportUrl('');
    setArchiveUrl('');
    setRunError('');
  }

  function handleCircleMode(nextMode: CircleSourceMode) {
    if (nextMode === circleMode && circleFile) return;
    userSelectedCircleRef.current = false;
    setCircleMode(nextMode);
    setCircleHasAudio(nextMode === 'video');
    setCircleFile(null);
    setCircleFileName('');
    clearRunResult();
    void loadDefaultCircle(nextMode);
  }

  function handleCircleFile(file: File | null) {
    if (!file) return;

    userSelectedCircleRef.current = true;
    circleLoadRequestRef.current += 1;

    const inferredMode = inferCircleMode(file) ?? circleMode;
    setCircleMode(inferredMode);
    setCircleHasAudio(inferredMode === 'video');
    setCircleFile(file);
    setCircleFileName(file.name);
    clearRunResult();
  }

  async function loadDefaultCircle(nextMode: CircleSourceMode) {
    const requestId = circleLoadRequestRef.current + 1;
    circleLoadRequestRef.current = requestId;
    const asset = CIRCLE_PREFILL[nextMode];

    try {
      const resp = await fetch(asset.url);
      if (!resp.ok) throw new Error(`fetch ${asset.url} -> ${resp.status}`);
      const blob = await resp.blob();
      if (circleLoadRequestRef.current !== requestId || userSelectedCircleRef.current) {
        return;
      }

      setCircleMode(nextMode);
      setCircleHasAudio(nextMode === 'video');
      setCircleFile(new File([blob], asset.name, { type: asset.type }));
      setCircleFileName(asset.name);
    } catch (err) {
      if (circleLoadRequestRef.current !== requestId) return;
      setCircleFile(null);
      setCircleFileName('');
      setRunError(
        err instanceof Error
          ? `Could not load ${asset.name}: ${err.message}`
          : `Could not load ${asset.name}`,
      );
    }
  }

  async function startRun() {
    if (!csvFile || !circleFile || !websiteColumn) return;

    setRunError('');
    setBatchId('');
    setReportUrl('');
    setArchiveUrl('');
    setLeads((current) =>
      current.map((lead) => ({
        ...lead,
        id: `csv-${lead.rowIndex + 1}`,
        status: 'pending',
        progress: 0,
        outputPath: undefined,
        error: undefined,
      })),
    );
    setIsRunning(true);

    const form = new FormData();
    form.set('csv', csvFile);
    form.set('circle', circleFile);
    if (audioFile) form.set('audio', audioFile);
    form.set('circleHasAudio', circleMode === 'video' && circleHasAudio ? 'true' : 'false');
    form.set('websiteColumn', websiteColumn);
    form.set('durationSec', String(durationSec));
    form.set('resolution', resolution);
    form.set('circlePosition', circlePosition);
    form.set('circleSize', circleSize);
    form.set('circleMargin', '40');
    form.set('circleCropScale', String(circleCropScale));
    form.set('circleCropX', String(circleCropX));
    form.set('circleCropY', String(circleCropY));
    form.set('captureMode', captureMode);
    form.set('filenameTemplate', filenameTemplate);
    form.set('maxLeads', String(prospectLimit));

    try {
      const response = await fetch('/api/batches', {
        method: 'POST',
        body: form,
      });
      const body = (await response.json()) as StartBatchResponse;
      if (!response.ok) {
        throw new Error(body.error ?? 'Could not start batch');
      }

      setBatchId(body.batchId);
      setReportUrl(body.reportUrl);
      setArchiveUrl(body.archiveUrl);
      subscribeToBatch(body.eventsUrl);
    } catch (err) {
      setIsRunning(false);
      setRunError(err instanceof Error ? err.message : String(err));
    }
  }

  function subscribeToBatch(eventsUrl: string) {
    const source = new EventSource(eventsUrl);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as BatchEvent | BatchErrorEvent;
      if (event.type === 'batch-error') {
        setRunError(event.error);
        setIsRunning(false);
        source.close();
        return;
      }
      applyBatchEvent(event);
      if (event.type === 'batch-completed') {
        setIsRunning(false);
        source.close();
      }
    };
    source.onerror = () => {
      setRunError('Lost batch event stream');
      setIsRunning(false);
      source.close();
    };
  }

  function applyBatchEvent(event: BatchEvent) {
    if (event.type === 'lead-status') {
      setLeads((current) =>
        updateLeadStatus(current, event.leadId, event.status, event.error),
      );
    }
    if (event.type === 'lead-completed') {
      setLeads((current) => updateLeadCompleted(current, event.leadId, event.outputPath));
    }
  }

  const canStart =
    leads.length > 0 &&
    csvFile !== null &&
    circleFile !== null &&
    websiteColumn !== '' &&
    !isRunning;

  return (
    <div className="workbench">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">LM</div>
          <div className="brand-copy">
            <h1>Loom Morph</h1>
            <p>Batch video generator</p>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="button" type="button" onClick={resetRun}>
            <span className="icon" aria-hidden="true">
              R
            </span>
            Reset
          </button>
          <button
            className="button primary"
            type="button"
            disabled={!canStart}
            onClick={startRun}
          >
            <span className="icon" aria-hidden="true">
              ▶
            </span>
            Start Batch
          </button>
        </div>
      </header>

      <div className="layout-grid">
        <section className="setup-column" aria-label="Batch setup">
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">
                <h2>Inputs</h2>
                <span>{runError || parseMessage}</span>
              </div>
            </div>
            <div className="panel-body stack">
              <div className="field">
                <label htmlFor="csv-file">Lead CSV</label>
                <input
                  className="file-input"
                  id="csv-file"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    handleCsv(event.target.files?.[0]);
                    event.currentTarget.value = '';
                  }}
                />
              </div>
              <div className="field">
                <label htmlFor="circle-file">Circle Source</label>
                <div className="segmented" role="group" aria-label="Circle source type">
                  {(['image', 'video'] as CircleSourceMode[]).map((item) => (
                    <button
                      className={`segment ${circleMode === item ? 'active' : ''}`}
                      key={item}
                      type="button"
                      onClick={() => handleCircleMode(item)}
                    >
                      {item[0]!.toUpperCase() + item.slice(1)}
                    </button>
                  ))}
                </div>
                <input
                  className="file-input"
                  id="circle-file"
                  type="file"
                  accept={CIRCLE_ACCEPT[circleMode]}
                  onChange={(event) => {
                    handleCircleFile(event.target.files?.[0] ?? null);
                    event.currentTarget.value = '';
                  }}
                />
                {circleMode === 'video' ? (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={circleHasAudio}
                      onChange={(event) => setCircleHasAudio(event.target.checked)}
                    />
                    <span>Use circle video audio</span>
                  </label>
                ) : null}
              </div>
              <div className="field">
                <label htmlFor="audio-file">Narration MP3</label>
                <input
                  className="file-input"
                  id="audio-file"
                  type="file"
                  accept="audio/mpeg"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    setAudioFile(file);
                    setAudioFileName(file?.name ?? '');
                  }}
                />
              </div>
              {csvDataset && csvDataset.columns.length > 0 ? (
                <div className="mapper-grid">
                  <div className="field">
                    <label htmlFor="website-column">Website column</label>
                    <select
                      className="select-input"
                      id="website-column"
                      value={websiteColumn}
                      onChange={(event) => setWebsiteColumn(event.target.value)}
                    >
                      <option value="">Select column</option>
                      {csvDataset.columns.map((column) => (
                        <option key={column} value={column}>
                          {column}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="company-column">Company column</label>
                    <select
                      className="select-input"
                      id="company-column"
                      value={companyColumn}
                      onChange={(event) => setCompanyColumn(event.target.value)}
                    >
                      <option value="">None</option>
                      {csvDataset.columns.map((column) => (
                        <option key={column} value={column}>
                          {column}
                        </option>
                      ))}
                    </select>
                  </div>
                  {websiteColumnStats ? (
                    <div className="mapper-note">
                      <strong>
                        {websiteColumnStats.queued > 0
                          ? `${websiteColumnStats.queued} selected`
                          : 'No usable websites'}
                      </strong>
                      <span>
                        {websiteColumnStats.usable > MAX_BATCH_LEADS
                          ? `${websiteColumnStats.usable} valid rows found, capped at ${MAX_BATCH_LEADS}.`
                          : `${websiteColumnStats.usable} valid row${
                              websiteColumnStats.usable === 1 ? '' : 's'
                            } found.`}
                      </span>
                      {websiteColumnStats.rejected.length > 0 ? (
                        <span>
                          Rejected: {websiteColumnStats.rejected.join(', ')}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="file-list">
                <FileChip label="CSV" value={csvFileName || 'sample.csv'} />
                <FileChip label="Circle" value={circleFileName || 'required'} />
                <FileChip label="Audio" value={audioFileName || 'none'} />
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">
                <h2>Video Settings</h2>
                <span>{durationSec}s</span>
              </div>
            </div>
            <div className="panel-body stack">
              <div className="field-row">
                <div className="field">
                  <label htmlFor="prospect-limit">Prospects to process</label>
                  <input
                    className="text-input"
                    id="prospect-limit"
                    min={1}
                    max={maxProspectLimit}
                    type="number"
                    value={prospectLimit}
                    onChange={(event) =>
                      setProspectLimit(
                        clampNumber(Number(event.target.value) || 1, 1, maxProspectLimit),
                      )
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="duration">Duration</label>
                  <input
                    className="text-input"
                    id="duration"
                    min={10}
                    max={90}
                    type="number"
                    value={durationSec}
                    onChange={(event) =>
                      setDurationSec(Number(event.target.value) || 30)
                    }
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="filename-template">Filename</label>
                <input
                  className="text-input"
                  id="filename-template"
                  value={filenameTemplate}
                  onChange={(event) => setFilenameTemplate(event.target.value)}
                />
              </div>

              <div className="field">
                <div className="field-label">Capture Mode</div>
                <div className="segmented" role="group" aria-label="Capture mode">
                  {(['screenshot', 'recording'] as CaptureMode[]).map((item) => (
                    <button
                      className={`segment ${captureMode === item ? 'active' : ''}`}
                      key={item}
                      type="button"
                      onClick={() => setCaptureMode(item)}
                      title={
                        item === 'screenshot'
                          ? 'Pans a static screenshot — fast, parallel-friendly. Hero videos and animations are frozen at their loaded frame.'
                          : 'Records the live page — captures hero videos, parallax, autoplay backgrounds. Slower (real-time-bound).'
                      }
                    >
                      {item === 'screenshot' ? 'Static' : 'Live'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <div className="field-label">Resolution</div>
                <div className="segmented" role="group" aria-label="Resolution">
                  {(['1080p', '720p'] as Resolution[]).map((item) => (
                    <button
                      className={`segment ${resolution === item ? 'active' : ''}`}
                      key={item}
                      type="button"
                      onClick={() => setResolution(item)}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <div className="field-label">Circle Size</div>
                <div className="segmented three" role="group" aria-label="Circle size">
                  {(['S', 'M', 'L'] as CircleSize[]).map((item) => (
                    <button
                      className={`segment ${circleSize === item ? 'active' : ''}`}
                      key={item}
                      type="button"
                      onClick={() => setCircleSize(item)}
                    >
                      {SIZE_LABELS[item]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <div className="field-label">Circle Position</div>
                <div className="corner-grid">
                  {(
                    [
                      'top-left',
                      'top-right',
                      'bottom-left',
                      'bottom-right',
                    ] as CirclePosition[]
                  ).map((item) => (
                    <button
                      className={`corner-button ${
                        circlePosition === item ? 'active' : ''
                      }`}
                      key={item}
                      type="button"
                      onClick={() => setCirclePosition(item)}
                    >
                      {labelPosition(item)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">
                <h2>Preview</h2>
                <span>{resolution}</span>
              </div>
            </div>
            <div className="panel-body">
              <div className="preview-controls">
                <div className="field">
                  <label htmlFor="preview-website">Preview website</label>
                  <input
                    className="text-input"
                    id="preview-website"
                    value={previewWebsite}
                    onChange={(event) => {
                      previewWebsiteTouchedRef.current = true;
                      setPreviewWebsite(event.target.value);
                    }}
                    onBlur={() => {
                      setPreviewWebsite(normalizeWebsite(previewWebsite) ?? previewWebsite);
                    }}
                  />
                </div>
                <div className="crop-controls">
                  <div className="field">
                    <label htmlFor="circle-crop-scale">Circle crop</label>
                    <input
                      className="range-input"
                      id="circle-crop-scale"
                      min={1}
                      max={2.5}
                      step={0.05}
                      type="range"
                      value={circleCropScale}
                      onChange={(event) => setCircleCropScale(Number(event.target.value))}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="circle-crop-x">X</label>
                    <input
                      className="range-input"
                      id="circle-crop-x"
                      min={-100}
                      max={100}
                      step={1}
                      type="range"
                      value={circleCropX}
                      onChange={(event) => setCircleCropX(Number(event.target.value))}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="circle-crop-y">Y</label>
                    <input
                      className="range-input"
                      id="circle-crop-y"
                      min={-100}
                      max={100}
                      step={1}
                      type="range"
                      value={circleCropY}
                      onChange={(event) => setCircleCropY(Number(event.target.value))}
                    />
                  </div>
                </div>
              </div>
              <div className="preview-frame">
                <div className="browser-bar">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                  {normalizedPreviewWebsite ? (
                    <span className="browser-address">{normalizedPreviewWebsite}</span>
                  ) : null}
                </div>
                {normalizedPreviewWebsite ? (
                  <iframe
                    className="preview-website-frame"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    sandbox="allow-scripts allow-same-origin"
                    src={normalizedPreviewWebsite}
                    title="Preview website"
                  />
                ) : (
                  <div className="mock-site">
                    <div className="mock-hero" />
                    <div className="mock-line" />
                    <div className="mock-line short" />
                    <div className="mock-grid">
                      <div className="mock-block" />
                      <div className="mock-block" />
                      <div className="mock-block" />
                    </div>
                  </div>
                )}
                <div
                  className={`face-bubble bubble-${circlePosition}`}
                  style={
                    {
                      '--bubble-size': BUBBLE_PREVIEW[circleSize],
                      '--bubble-margin': '18px',
                      '--circle-media-scale': circleCropScale,
                      '--circle-media-x': `${50 + circleCropX / 2}%`,
                      '--circle-media-y': `${50 + circleCropY / 2}%`,
                    } as React.CSSProperties
                  }
                >
                  {circlePreviewUrl && circleMode === 'image' ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      alt=""
                      className="face-bubble-media"
                      src={circlePreviewUrl}
                    />
                  ) : null}
                  {circlePreviewUrl && circleMode === 'video' ? (
                    <video
                      aria-label="Circle source preview"
                      autoPlay
                      className="face-bubble-media"
                      loop
                      muted
                      playsInline
                      src={circlePreviewUrl}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="run-column" aria-label="Batch run">
          <div className="summary-strip">
            <Metric label="Selected" value={String(leads.length)} />
            <Metric label="Processed" value={`${summary.processed}/${leads.length}`} />
            <Metric label="Active" value={String(summary.active)} />
            <Metric label="Done" value={String(summary.done)} />
            <Metric label="Failed" value={String(summary.failed)} />
          </div>

          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">
                <h2>Batch Progress</h2>
                <span>{batchId ? batchId.slice(0, 8) : `${summary.totalProgress}%`}</span>
              </div>
              <div className="toolbar">
                <a
                  className={`button ${
                    archiveUrl && !isRunning && summary.done > 0
                      ? ''
                      : 'disabled-link'
                  }`}
                  href={archiveUrl || '#'}
                  aria-disabled={!archiveUrl || isRunning || summary.done === 0}
                  tabIndex={
                    archiveUrl && !isRunning && summary.done > 0 ? undefined : -1
                  }
                  onClick={(event) => {
                    if (!archiveUrl || isRunning || summary.done === 0) {
                      event.preventDefault();
                    }
                  }}
                >
                  <span className="icon" aria-hidden="true">
                    ↓
                  </span>
                  MP4s
                </a>
                <a
                  className={`button ${reportUrl && !isRunning ? '' : 'disabled-link'}`}
                  href={reportUrl || '#'}
                  aria-disabled={!reportUrl || isRunning}
                  tabIndex={reportUrl && !isRunning ? undefined : -1}
                  onClick={(event) => {
                    if (!reportUrl || isRunning) event.preventDefault();
                  }}
                >
                  <span className="icon" aria-hidden="true">
                    #
                  </span>
                  Report
                </a>
              </div>
            </div>
            <div className="panel-body stack">
              <div className="progress-track" aria-label="Overall progress">
                <div
                  className="progress-fill"
                  style={{ width: `${summary.totalProgress}%` }}
                />
              </div>

              {leads.length > 0 ? (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Company</th>
                        <th>Website</th>
                        <th>Status</th>
                        <th>Progress</th>
                        <th>Output</th>
                      </tr>
                    </thead>
                    <tbody>
                      {leads.map((lead) => (
                        <tr key={lead.id}>
                          <td>{lead.rowIndex + 1}</td>
                          <td>{lead.company}</td>
                          <td className="url-cell">{lead.website}</td>
                          <td>
                            <span className={`status-pill status-${lead.status}`}>
                              {lead.status}
                            </span>
                          </td>
                          <td>
                            <div className="progress-track">
                              <div
                                className="progress-fill"
                                style={{ width: `${lead.progress}%` }}
                              />
                            </div>
                          </td>
                          <td>{lead.error || (lead.outputPath ? 'ready' : '-')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty-state">
                  <div>
                    <strong>No leads</strong>
                    <p>
                      {csvDataset
                        ? 'Choose the column that contains each lead website.'
                        : 'Upload a CSV with lead websites.'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function FileChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="file-chip">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function labelPosition(position: CirclePosition): string {
  return position
    .split('-')
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}

function cleanCsvHeader(header: string): string {
  return header.replace(/^\uFEFF/, '').trim();
}

function inferColumn(
  columns: string[],
  predicate: (column: string) => boolean,
): string {
  return columns.find(predicate) ?? '';
}

function inferCircleMode(file: File): CircleSourceMode | null {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (type.startsWith('video/') || /\.(mp4|mov|webm|mkv)$/.test(name)) {
    return 'video';
  }
  if (type.startsWith('image/') || /\.(png|jpe?g)$/.test(name)) {
    return 'image';
  }
  return null;
}

function buildLeadPreview(
  rows: CsvRow[],
  selectedWebsiteColumn: string,
  selectedCompanyColumn: string,
  limit: number = MAX_BATCH_LEADS,
): LeadPreview[] {
  if (!selectedWebsiteColumn) return [];

  return rows
    .map((row, index): LeadPreview | null => {
      const website = normalizePreviewWebsite(row[selectedWebsiteColumn] ?? '');
      if (!website) return null;
      const companyValue = selectedCompanyColumn
        ? row[selectedCompanyColumn]
        : undefined;

      return {
        id: `csv-${index + 1}`,
        rowIndex: index,
        website,
        company: companyValue || `Lead ${index + 1}`,
        status: 'pending',
        progress: 0,
      };
    })
    .filter((lead): lead is LeadPreview => lead !== null)
    .slice(0, Math.min(limit, MAX_BATCH_LEADS));
}

function isWebsiteHeader(header: string): boolean {
  const compact = header
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  return (
    compact === 'website' ||
    compact === 'url' ||
    compact === 'websiteurl' ||
    compact === 'site' ||
    compact === 'domain' ||
    compact === 'companywebsite' ||
    compact === 'companydomain'
  );
}

function isCompanyHeader(header: string): boolean {
  const compact = header
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  return (
    compact === 'company' ||
    compact === 'companyname' ||
    compact === 'account' ||
    compact === 'organization' ||
    compact === 'name'
  );
}

function normalizePreviewWebsite(value: string): string {
  return normalizeWebsite(value) ?? '';
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function csvParseMessage({
  fileName,
  leadCount,
  errorCount,
  hasColumns,
  websiteColumn,
}: {
  fileName: string;
  leadCount: number;
  errorCount: number;
  hasColumns: boolean;
  websiteColumn: string;
}): string {
  if (!hasColumns) return `No columns found in ${fileName}`;
  if (!websiteColumn) return 'Choose website column';
  if (leadCount === 0) return `No usable websites in ${websiteColumn}`;
  const leadText = `${leadCount} lead${leadCount === 1 ? '' : 's'} ready`;
  if (errorCount === 0) return leadText;
  return `${leadText}, ${errorCount} row warning${errorCount === 1 ? '' : 's'}`;
}

function updateLeadStatus(
  leads: LeadPreview[],
  leadId: string,
  status: LeadStatus,
  error?: string,
): LeadPreview[] {
  const existingIndex = leads.findIndex((lead) => lead.id === leadId);
  const targetIndex =
    existingIndex >= 0
      ? existingIndex
      : firstLeadForStatus(leads, status);

  if (targetIndex < 0) return leads;

  return leads.map((lead, index) => {
    if (index !== targetIndex) return lead;
    return {
      ...lead,
      id: leadId,
      status,
      progress: progressForStatus(status),
      outputPath: status === 'failed' ? undefined : lead.outputPath,
      error,
    };
  });
}

function updateLeadCompleted(
  leads: LeadPreview[],
  leadId: string,
  outputPath: string,
): LeadPreview[] {
  const existingIndex = leads.findIndex((lead) => lead.id === leadId);
  const targetIndex =
    existingIndex >= 0
      ? existingIndex
      : leads.findIndex((lead) => lead.status === 'rendering');

  if (targetIndex < 0) return leads;

  return leads.map((lead, index) => {
    if (index !== targetIndex) return lead;
    return {
      ...lead,
      id: leadId,
      status: 'done',
      progress: 100,
      outputPath,
      error: undefined,
    };
  });
}

function firstLeadForStatus(leads: LeadPreview[], status: LeadStatus): number {
  if (status === 'capturing') {
    return leads.findIndex((lead) => lead.status === 'pending');
  }
  if (status === 'rendering') {
    return leads.findIndex((lead) => lead.status === 'capturing');
  }
  if (status === 'failed') {
    const active = leads.findIndex(
      (lead) => lead.status === 'capturing' || lead.status === 'rendering',
    );
    return active >= 0 ? active : leads.findIndex((lead) => lead.status === 'pending');
  }
  return leads.findIndex((lead) => lead.status === 'pending');
}

function progressForStatus(status: LeadStatus): number {
  switch (status) {
    case 'capturing':
      return 35;
    case 'rendering':
      return 72;
    case 'done':
      return 100;
    case 'failed':
      return 100;
    case 'pending':
      return 0;
  }
}

function renderFilename(template: string, lead: LeadPreview): string {
  const fallback = `lead-${lead.rowIndex + 1}.mp4`;
  if (!template.trim()) return fallback;
  const resolved = template
    .replaceAll('{company}', lead.company)
    .replaceAll('{i}', String(lead.rowIndex + 1))
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim();

  if (!resolved) return fallback;
  return /\.mp4$/i.test(resolved) ? resolved : `${resolved}.mp4`;
}
