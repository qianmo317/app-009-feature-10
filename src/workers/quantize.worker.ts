import { quantizeImage } from '../utils/quantize';

const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent) => {
  try {
    const { imageData, maxColors } = e.data;
    if (!imageData?.data?.length) {
      ctx.postMessage({ error: '图像数据为空' });
      return;
    }
    if (!Number.isInteger(maxColors) || maxColors < 1) {
      ctx.postMessage({ error: '颜色数无效' });
      return;
    }
    const result = quantizeImage(imageData, maxColors);
    if (!result.palette.length) {
      ctx.postMessage({ error: '无法从图片中提取颜色' });
      return;
    }
    ctx.postMessage(result, [result.indices.buffer]);
  } catch (err) {
    ctx.postMessage({ error: err instanceof Error ? err.message : '量化计算失败' });
  }
};
