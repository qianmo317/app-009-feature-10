import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useChartStore } from '../store/chartStore';
import { rgbToHex } from '../utils/quantize';
import type { RGB } from '../utils/quantize';

const MIN_DIM = 1;
const MAX_DIM = 512;
const MIN_COLORS = 1;
const MAX_COLORS = 32;
const WORKER_TIMEOUT_MS = 15000;

type RowsMode = 'auto' | 'manual';

interface PreviewResult {
  cols: number;
  rows: number;
  colors: number; // 生成该预览时请求的最大颜色数，用于判断预览是否与当前参数一致
  palette: RGB[];
  indices: Uint16Array;
}

// 解析并校验全部参数，任一不合法返回 null（调用方据此禁用生成/应用）
function computeParams(
  colsInput: string,
  rowsInput: string,
  rowsMode: RowsMode,
  colorsInput: string,
  imgW: number,
  imgH: number
): { cols: number; rows: number; colors: number } | null {
  const cols = Number(colsInput);
  const colors = Number(colorsInput);
  const rows = rowsMode === 'auto' ? Math.round((cols * imgH) / imgW) : Number(rowsInput);
  const ok =
    Number.isInteger(cols) && cols >= MIN_DIM && cols <= MAX_DIM &&
    Number.isInteger(rows) && rows >= MIN_DIM && rows <= MAX_DIM &&
    Number.isInteger(colors) && colors >= MIN_COLORS && colors <= MAX_COLORS;
  return ok ? { cols, rows, colors } : null;
}

function dimError(value: string, label: string): string | null {
  if (value.trim() === '') return `请输入${label}`;
  const n = Number(value);
  if (!Number.isInteger(n)) return `${label}需为整数`;
  if (n < MIN_DIM || n > MAX_DIM) return `${label}需在 ${MIN_DIM}–${MAX_DIM} 之间`;
  return null;
}

function colorsError(value: string): string | null {
  if (value.trim() === '') return '请输入颜色数';
  const n = Number(value);
  if (!Number.isInteger(n)) return '颜色数需为整数';
  if (n < MIN_COLORS) return '颜色数不能为 0，至少 1 种';
  if (n > MAX_COLORS) return `颜色数超出上限（最多 ${MAX_COLORS} 种）`;
  return null;
}

// 把量化结果按格子画到画布上，放大显示时保持像素风
function ResultCanvas({ result }: { result: PreviewResult }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = result.cols;
    canvas.height = result.rows;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(result.cols, result.rows);
    for (let i = 0; i < result.indices.length; i++) {
      const [r, g, b] = result.palette[result.indices[i]] ?? ([255, 255, 255] as RGB);
      const o = i * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [result]);

  const k = Math.min(280 / result.cols, 232 / result.rows);
  const w = Math.max(1, Math.round(result.cols * k));
  const h = Math.max(1, Math.round(result.rows * k));

  return (
    <canvas
      ref={ref}
      style={{ width: w, height: h, imageRendering: 'pixelated', display: 'block' }}
    />
  );
}

export default function ImageImport() {
  const chart = useChartStore((s) => s.getCurrentChart());
  const updateChart = useChartStore((s) => s.updateChart);
  const setSelectedColorIndex = useChartStore((s) => s.setSelectedColorIndex);
  const setOffset = useChartStore((s) => s.setOffset);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [colsInput, setColsInput] = useState('64');
  const [rowsInput, setRowsInput] = useState('64');
  const [rowsMode, setRowsMode] = useState<RowsMode>('auto');
  const [colorsInput, setColorsInput] = useState('8');

  const fileRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const imgUrlRef = useRef<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const timeoutRef = useRef<number>(0);
  const jobRef = useRef(0);
  const lastSigRef = useRef('');

  const validParams = useMemo(
    () => (imgSize ? computeParams(colsInput, rowsInput, rowsMode, colorsInput, imgSize.w, imgSize.h) : null),
    [colsInput, rowsInput, rowsMode, colorsInput, imgSize]
  );

  // 终止当前计算并使尚未返回的回调失效
  const stopWorker = () => {
    jobRef.current++;
    workerRef.current?.terminate();
    workerRef.current = null;
    clearTimeout(timeoutRef.current);
  };

  const fail = (message: string) => {
    stopWorker();
    setBusy(false);
    setError(message);
  };

  const runConversion = (cols: number, rows: number, colors: number) => {
    const img = imgRef.current;
    if (!img) return;
    stopWorker();
    setBusy(true);
    setError(null);

    let imageData: ImageData;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = cols;
      canvas.height = rows;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(img, 0, 0, cols, rows);
      imageData = ctx.getImageData(0, 0, cols, rows);
    } catch {
      fail('转换失败：无法读取图片像素，请换一张图片重试');
      return;
    }

    const job = jobRef.current;
    const worker = new Worker(new URL('../workers/quantize.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    timeoutRef.current = window.setTimeout(() => {
      fail('转换超时：图片过大或颜色过多，请减小目标针数或颜色数后重试');
    }, WORKER_TIMEOUT_MS);

    worker.onmessage = (e: MessageEvent<{ palette: RGB[]; indices: Uint16Array }>) => {
      if (job !== jobRef.current) return;
      stopWorker();
      setBusy(false);
      setResult({ cols, rows, colors, palette: e.data.palette, indices: e.data.indices });
    };
    worker.onerror = () => {
      if (job !== jobRef.current) return;
      fail('转换失败：处理过程中出现错误，请重试或换一张图片');
    };
    worker.postMessage({ imageData, maxColors: colors });
  };

  const handleFile = (file: File) => {
    stopWorker();
    if (imgUrlRef.current) URL.revokeObjectURL(imgUrlRef.current);
    imgRef.current = null;
    lastSigRef.current = '';
    setImgUrl(null);
    setImgSize(null);
    setResult(null);
    setError(null);
    setOpen(true);
    setBusy(true);

    const url = URL.createObjectURL(file);
    imgUrlRef.current = url;
    const img = new Image();
    img.onload = () => {
      if (imgUrlRef.current !== url) return; // 已被更新的选择取代
      imgRef.current = img;
      setImgUrl(url);
      setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
      const params = computeParams(colsInput, rowsInput, rowsMode, colorsInput, img.naturalWidth, img.naturalHeight);
      if (params) {
        lastSigRef.current = `${params.cols}x${params.rows}x${params.colors}`;
        runConversion(params.cols, params.rows, params.colors);
      } else {
        setBusy(false);
      }
    };
    img.onerror = () => {
      if (imgUrlRef.current !== url) return;
      URL.revokeObjectURL(url);
      imgUrlRef.current = null;
      imgRef.current = null;
      setBusy(false);
      setError('图片加载失败：文件已损坏或格式不支持，请重新选择图片');
    };
    img.src = url;
  };

  // 放弃本次导入：终止计算、释放资源，画布保持原样
  const closeModal = () => {
    stopWorker();
    if (imgUrlRef.current) {
      URL.revokeObjectURL(imgUrlRef.current);
      imgUrlRef.current = null;
    }
    imgRef.current = null;
    lastSigRef.current = '';
    setOpen(false);
    setBusy(false);
    setError(null);
    setImgUrl(null);
    setImgSize(null);
    setResult(null);
  };

  const retry = () => {
    if (!validParams) return;
    lastSigRef.current = `${validParams.cols}x${validParams.rows}x${validParams.colors}`;
    runConversion(validParams.cols, validParams.rows, validParams.colors);
  };

  const apply = () => {
    if (!chart || !result) return;
    const newPalette = result.palette.map((rgb, i) => ({
      id: Math.random().toString(36).slice(2),
      name: `颜色 ${i + 1}`,
      hex: rgbToHex(rgb),
    }));
    updateChart(chart.id, (c) => ({
      ...c,
      cols: result.cols,
      rows: result.rows,
      palette: newPalette,
      cells: result.indices,
    }));
    const sel = useChartStore.getState().selectedColorIndex;
    if (sel >= newPalette.length) {
      setSelectedColorIndex(Math.max(0, newPalette.length - 1));
    }
    setOffset({ x: 0, y: 0 });
    closeModal();
  };

  // 卸载时释放 Worker 与图片资源
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      clearTimeout(timeoutRef.current);
      if (imgUrlRef.current) URL.revokeObjectURL(imgUrlRef.current);
    };
  }, []);

  // 参数变化且合法时自动重新生成预览（防抖）；签名相同则跳过，避免与首次生成重复
  useEffect(() => {
    if (!open || !validParams) return;
    const sig = `${validParams.cols}x${validParams.rows}x${validParams.colors}`;
    if (sig === lastSigRef.current) return;
    const t = window.setTimeout(() => {
      lastSigRef.current = sig;
      runConversion(validParams.cols, validParams.rows, validParams.colors);
    }, 400);
    return () => clearTimeout(t);
  }, [open, validParams]);

  // Esc 关闭预览
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const colsErr = dimError(colsInput, '针数');
  const rowsErr = rowsMode === 'manual' ? dimError(rowsInput, '行数') : null;
  const colorsErr = colorsError(colorsInput);
  const autoRows = imgSize && !colsErr ? Math.round((Number(colsInput) * imgSize.h) / imgSize.w) : null;
  const autoRowsErr =
    rowsMode === 'auto' && autoRows !== null && (autoRows < MIN_DIM || autoRows > MAX_DIM)
      ? `按原图比例需 ${autoRows} 行，超出 ${MIN_DIM}–${MAX_DIM} 范围，请减小目标针数或改用自定义行数`
      : null;
  const canApply =
    !!chart && !!result && !busy && !!validParams &&
    result.cols === validParams.cols && result.rows === validParams.rows && result.colors === validParams.colors;
  const orientation = imgSize ? (imgSize.w > imgSize.h ? '横版' : imgSize.w < imgSize.h ? '竖版' : '方形') : '';

  return (
    <div style={{ padding: 12, borderBottom: '1px solid #e0dcd5' }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600 }}>图片转图解</h3>
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        ref={fileRef}
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.target.value = '';
        }}
      />
      <p style={{ margin: '0 0 8px', fontSize: 11, color: '#888', lineHeight: 1.5 }}>
        导入后先生成对照预览，可调整针数与颜色数，确认后再替换当前画布
      </p>
      <button
        onClick={() => fileRef.current?.click()}
        disabled={!chart}
        style={{ ...primaryBtn, opacity: chart ? 1 : 0.6, cursor: chart ? 'pointer' : 'not-allowed' }}
      >
        选择图片…
      </button>

      {open && (
        <div
          style={overlayStyle}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div style={dialogStyle}>
            <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600 }}>图片转图解 · 预览确认</h3>
            <p style={{ margin: '0 0 12px', fontSize: 11, color: '#888' }}>
              确认无误后再应用到画布；修改针数、行数或颜色数会自动重新生成预览
            </p>

            {error && (
              <div style={errorBanner}>
                <span style={{ flex: 1 }}>{error}</span>
                {imgUrl && validParams && (
                  <button onClick={retry} style={retryBtn}>重试</button>
                )}
              </div>
            )}

            {imgUrl && imgSize ? (
              <>
                <div style={{ display: 'flex', gap: 12 }}>
                  <div style={previewBox}>
                    <div style={previewInner}>
                      <img src={imgUrl} alt="原图" style={{ maxWidth: '100%', maxHeight: 232, display: 'block' }} />
                    </div>
                    <div style={captionStyle}>原图 {imgSize.w}×{imgSize.h}（{orientation}）</div>
                  </div>
                  <div style={previewBox}>
                    <div style={{ ...previewInner, opacity: busy ? 0.5 : 1 }}>
                      {result
                        ? <ResultCanvas result={result} />
                        : <span style={{ fontSize: 12, color: '#999' }}>{busy ? '计算中…' : '暂无预览'}</span>}
                    </div>
                    <div style={captionStyle}>
                      {result
                        ? `转换后 ${result.cols}×${result.rows} · 实际 ${result.palette.length} 色`
                        : busy ? '正在生成预览…' : '修正参数后自动生成'}
                    </div>
                  </div>
                </div>

                {result && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
                    {result.palette.map((rgb, i) => (
                      <div
                        key={i}
                        title={rgbToHex(rgb)}
                        style={{ width: 16, height: 16, borderRadius: 3, background: rgbToHex(rgb), border: '1px solid #ddd' }}
                      />
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                  <div style={{ flex: 1 }}>
                    <label style={fieldLabel}>
                      目标针数（{MIN_DIM}–{MAX_DIM}）
                      <input
                        type="number"
                        value={colsInput}
                        onChange={(e) => setColsInput(e.target.value)}
                        style={{ ...numInput, borderColor: colsErr ? '#e74c3c' : '#ddd' }}
                      />
                    </label>
                    {colsErr && <div style={errText}>{colsErr}</div>}
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={fieldLabel}>
                      最多颜色数（{MIN_COLORS}–{MAX_COLORS}）
                      <input
                        type="number"
                        value={colorsInput}
                        onChange={(e) => setColorsInput(e.target.value)}
                        style={{ ...numInput, borderColor: colorsErr ? '#e74c3c' : '#ddd' }}
                      />
                    </label>
                    {colorsErr && <div style={errText}>{colorsErr}</div>}
                  </div>
                </div>

                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, marginBottom: 4 }}>行数</div>
                  <label style={radioLabel}>
                    <input type="radio" name="rows-mode" checked={rowsMode === 'auto'} onChange={() => setRowsMode('auto')} />
                    按原图比例{autoRows !== null && !autoRowsErr ? `（${autoRows} 行）` : ''}
                  </label>
                  <label style={{ ...radioLabel, marginTop: 4 }}>
                    <input type="radio" name="rows-mode" checked={rowsMode === 'manual'} onChange={() => setRowsMode('manual')} />
                    自定义行数
                    <input
                      type="number"
                      value={rowsInput}
                      disabled={rowsMode !== 'manual'}
                      onChange={(e) => setRowsInput(e.target.value)}
                      style={{ ...numInput, width: 70, borderColor: rowsErr ? '#e74c3c' : '#ddd' }}
                    />
                  </label>
                  {rowsErr && <div style={errText}>{rowsErr}</div>}
                  {autoRowsErr && <div style={errText}>{autoRowsErr}</div>}
                </div>

                {chart && (
                  <div style={{ marginTop: 12, fontSize: 11, color: '#b03a2e' }}>
                    应用后将替换当前画布（{chart.cols}×{chart.rows} · {chart.palette.length} 色），已绘制的内容会被覆盖
                  </div>
                )}
              </>
            ) : (
              <div style={{ padding: '32px 0', textAlign: 'center', fontSize: 12, color: '#888' }}>
                {busy ? '图片加载中…' : '图片未加载，请重新选择'}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
              <button onClick={() => fileRef.current?.click()} style={linkBtn}>重新选择图片</button>
              <div style={{ flex: 1 }} />
              {busy && <span style={{ fontSize: 11, color: '#888' }}>计算中…</span>}
              <button onClick={closeModal} style={secondaryBtn}>取消</button>
              <button
                onClick={apply}
                disabled={!canApply}
                style={{ ...primaryBtn, opacity: canApply ? 1 : 0.5, cursor: canApply ? 'pointer' : 'not-allowed' }}
              >
                应用到画布
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const primaryBtn: CSSProperties = {
  padding: '6px 12px',
  fontSize: 12,
  borderRadius: 4,
  border: '1px solid #3498db',
  background: '#3498db',
  color: '#fff',
  cursor: 'pointer',
};

const secondaryBtn: CSSProperties = {
  padding: '6px 12px',
  fontSize: 12,
  borderRadius: 4,
  border: '1px solid #bdc3c7',
  background: '#fff',
  color: '#333',
  cursor: 'pointer',
};

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const dialogStyle: CSSProperties = {
  background: '#fff',
  borderRadius: 8,
  padding: 16,
  width: 640,
  maxWidth: '92vw',
  maxHeight: '88vh',
  overflow: 'auto',
  boxShadow: '0 8px 30px rgba(0,0,0,0.2)',
};

const previewBox: CSSProperties = { flex: 1, minWidth: 0 };

const previewInner: CSSProperties = {
  height: 240,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#faf8f5',
  border: '1px solid #e0dcd5',
  borderRadius: 4,
  overflow: 'hidden',
};

const captionStyle: CSSProperties = { marginTop: 4, fontSize: 11, color: '#888', textAlign: 'center' };

const fieldLabel: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 };

const numInput: CSSProperties = {
  width: 90,
  fontSize: 12,
  padding: '3px 6px',
  borderRadius: 4,
  border: '1px solid #ddd',
};

const errText: CSSProperties = { marginTop: 4, fontSize: 11, color: '#e74c3c' };

const radioLabel: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 };

const errorBanner: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: '#fdedec',
  border: '1px solid #f5b7b1',
  color: '#b03a2e',
  borderRadius: 4,
  padding: '6px 8px',
  fontSize: 12,
  marginBottom: 10,
};

const linkBtn: CSSProperties = {
  border: 'none',
  background: 'none',
  color: '#3498db',
  fontSize: 12,
  cursor: 'pointer',
  padding: 0,
};

const retryBtn: CSSProperties = {
  padding: '2px 10px',
  fontSize: 12,
  borderRadius: 4,
  border: '1px solid #b03a2e',
  background: '#fff',
  color: '#b03a2e',
  cursor: 'pointer',
};
