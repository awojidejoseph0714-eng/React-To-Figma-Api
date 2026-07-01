// api/extract.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright-core';
import { readFileSync } from 'fs';
import { join } from 'path';

const BROWSERLESS_WS = process.env.BROWSERLESS_WS_URL;

if (!BROWSERLESS_WS) {
  throw new Error('Missing required env var: BROWSERLESS_WS_URL');
}

// ─── Read React scripts once at module load (warm instance reuses) ───
const REACT_SCRIPT = readFileSync(
  join(process.cwd(), 'node_modules/react/umd/react.production.min.js'),
  'utf-8'
);
const REACT_DOM_SCRIPT = readFileSync(
  join(process.cwd(), 'node_modules/react-dom/umd/react-dom.production.min.js'),
  'utf-8'
);

// ─── Browser connection pool ───
let browserPromise: Promise<any> | null = null;

async function getBrowser() {
  if (!browserPromise) {
    // ─── Diagnostic logging: confirms exactly what value Playwright receives ───
    console.log('BROWSERLESS_WS raw value:', JSON.stringify(BROWSERLESS_WS));
    console.log('BROWSERLESS_WS length:', BROWSERLESS_WS?.length);
    console.log('BROWSERLESS_WS starts with wss://:', BROWSERLESS_WS?.startsWith('wss://'));

    browserPromise = chromium.connectOverCDP(BROWSERLESS_WS).catch(err => {
      console.error('Browserless connection failed:', err.message, err.stack);
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

// ─── Timing helper ───
const t = (label: string, start: number) => console.log(`[${label}] ${Date.now() - start}ms`);

// ─── Types ───
interface RGB { r: number; g: number; b: number; }

interface SceneNode {
  type: 'FRAME' | 'TEXT' | 'RECTANGLE' | 'ELLIPSE' | 'VECTOR' | 'COMPONENT';
  name: string;
  x: number; y: number; width: number; height: number;
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL';
  itemSpacing?: number;
  paddingTop?: number; paddingBottom?: number; paddingLeft?: number; paddingRight?: number;
  primaryAxisAlign?: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  counterAxisAlign?: 'MIN' | 'CENTER' | 'MAX';
  fills?: any[]; strokes?: any[]; strokeWeight?: number;
  topLeftRadius?: number; topRightRadius?: number; bottomLeftRadius?: number; bottomRightRadius?: number;
  effects?: any[];
  characters?: string;
  fontName?: { family: string; style: string };
  fontSize?: number;
  textAlignHorizontal?: string;
  lineHeight?: any; letterSpacing?: any;
  vectorPaths?: any[];
  children?: SceneNode[];
}

// ─── Color parsing ───
function parseColor(color: string): { color: RGB; opacity: number } | null {
  if (!color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return null;
  const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (rgbMatch) return { color: { r: parseInt(rgbMatch[1])/255, g: parseInt(rgbMatch[2])/255, b: parseInt(rgbMatch[3])/255 }, opacity: 1 };
  const rgbaMatch = color.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
  if (rgbaMatch) return { color: { r: parseInt(rgbaMatch[1])/255, g: parseInt(rgbaMatch[2])/255, b: parseInt(rgbaMatch[3])/255 }, opacity: parseFloat(rgbaMatch[4]) };
  const hexMatch = color.match(/#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?/);
  if (hexMatch) {
    const hex = hexMatch[1];
    const alpha = hexMatch[2] ? parseInt(hexMatch[2], 16)/255 : 1;
    return { color: { r: parseInt(hex.slice(0,2),16)/255, g: parseInt(hex.slice(2,4),16)/255, b: parseInt(hex.slice(4,6),16)/255 }, opacity: alpha };
  }
  const namedColors: Record<string,string> = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff' };
  if (namedColors[color.toLowerCase()]) return parseColor(namedColors[color.toLowerCase()]);
  return null;
}

function parseShadow(shadow: string): any | null {
  if (!shadow || shadow === 'none') return null;
  const firstShadow = shadow.split(',')[0].trim();
  const match = firstShadow.match(/([\d.-]+px)\s+([\d.-]+px)\s+([\d.-]+px)\s*(?:([\d.-]+px)\s*)?(rgba?\([^)]+\)|#[0-9a-fA-F]+|\w+)/);
  if (!match) return null;
  const [, xStr, yStr, blurStr, spreadStr, colorStr] = match;
  const color = parseColor(colorStr);
  if (!color) return null;
  return { type: 'DROP_SHADOW', color: { ...color.color, a: color.opacity }, offset: { x: parseFloat(xStr), y: parseFloat(yStr) }, radius: parseFloat(blurStr), spread: spreadStr ? parseFloat(spreadStr) : 0, visible: true };
}

function parseBorderRadius(computed: CSSStyleDeclaration) {
  const parse = (val: string) => { const n = parseFloat(val); return isNaN(n) ? 0 : n; };
  const all = parse(computed.borderRadius);
  if (all > 0 && computed.borderTopLeftRadius === computed.borderRadius) return { tl: all, tr: all, bl: all, br: all };
  return { tl: parse(computed.borderTopLeftRadius), tr: parse(computed.borderTopRightRadius), bl: parse(computed.borderBottomLeftRadius), br: parse(computed.borderBottomRightRadius) };
}

function detectLayout(computed: CSSStyleDeclaration) {
  if (computed.display !== 'flex' && computed.display !== 'inline-flex') return null;
  const isRow = computed.flexDirection === 'row' || computed.flexDirection === 'row-reverse';
  const justifyMap: Record<string, any> = { 'flex-start': 'MIN', start: 'MIN', center: 'CENTER', 'flex-end': 'MAX', end: 'MAX', 'space-between': 'SPACE_BETWEEN', 'space-around': 'SPACE_BETWEEN', 'space-evenly': 'SPACE_BETWEEN' };
  const alignMap: Record<string, any> = { 'flex-start': 'MIN', start: 'MIN', center: 'CENTER', 'flex-end': 'MAX', end: 'MAX', stretch: 'MIN' };
  return { layoutMode: isRow ? 'HORIZONTAL' : 'VERTICAL', itemSpacing: parseFloat(computed.gap) || 0, paddingTop: parseFloat(computed.paddingTop) || 0, paddingBottom: parseFloat(computed.paddingBottom) || 0, paddingLeft: parseFloat(computed.paddingLeft) || 0, paddingRight: parseFloat(computed.paddingRight) || 0, primaryAxisAlign: justifyMap[computed.justifyContent] || 'MIN', counterAxisAlign: alignMap[computed.alignItems] || 'MIN' };
}

function parseFont(computed: CSSStyleDeclaration) {
  const family = computed.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
  const weight = computed.fontWeight;
  let style = 'Regular';
  if (weight === '700' || weight === 'bold') style = 'Bold';
  else if (weight === '600') style = 'SemiBold';
  else if (weight === '500') style = 'Medium';
  else if (weight === '300' || weight === 'lighter') style = 'Light';
  if (computed.fontStyle === 'italic') style = style === 'Regular' ? 'Italic' : `${style} Italic`;
  let lineHeight: any; const lh = computed.lineHeight; if (lh === 'normal') lineHeight = { value: 120, unit: 'PERCENT' }; else if (lh.endsWith('px')) lineHeight = { value: parseFloat(lh), unit: 'PIXELS' }; else lineHeight = { value: parseFloat(lh)*100 || 120, unit: 'PERCENT' };
  let letterSpacing: any; const ls = computed.letterSpacing; if (ls === 'normal') letterSpacing = { value: 0, unit: 'PIXELS' }; else if (ls.endsWith('px')) letterSpacing = { value: parseFloat(ls), unit: 'PIXELS' }; else letterSpacing = { value: parseFloat(ls) || 0, unit: 'PIXELS' };
  let textCase: any = 'ORIGINAL'; if (computed.textTransform === 'uppercase') textCase = 'UPPER'; else if (computed.textTransform === 'lowercase') textCase = 'LOWER'; else if (computed.textTransform === 'capitalize') textCase = 'TITLE';
  return { fontName: { family: family || 'Inter', style }, fontSize: parseFloat(computed.fontSize) || 16, lineHeight, letterSpacing, textCase };
}

function extractNode(el: HTMLElement): SceneNode | null {
  const computed = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  if (computed.display === 'none' || computed.visibility === 'hidden') return null;
  let type: SceneNode['type'] = 'FRAME';
  let name = el.tagName.toLowerCase();
  if (el.tagName === 'IMG') { type = 'RECTANGLE'; name = 'Image'; }
  else if (el.children.length === 0 && el.textContent?.trim()) { type = 'TEXT'; name = el.textContent.trim().slice(0, 20) || 'Text'; }
  else if (el.tagName === 'BUTTON') name = 'Button';
  const testId = el.getAttribute('data-testid');
  if (testId) name = testId;
  const node: SceneNode = { type, name, x: Math.round(rect.left*100)/100, y: Math.round(rect.top*100)/100, width: Math.round(rect.width*100)/100, height: Math.round(rect.height*100)/100 };
  if (node.width === 0 || node.height === 0) return null;
  const layout = detectLayout(computed);
  if (layout) Object.assign(node, layout);
  const bgColor = parseColor(computed.backgroundColor);
  if (bgColor) node.fills = [{ type: 'SOLID', color: bgColor.color, opacity: bgColor.opacity }];
  if (type === 'TEXT') {
    const fgColor = parseColor(computed.color);
    if (fgColor) node.fills = [{ type: 'SOLID', color: fgColor.color, opacity: fgColor.opacity }];
    const fontInfo = parseFont(computed);
    Object.assign(node, fontInfo);
    node.characters = el.textContent?.trim() || '';
    node.textAlignHorizontal = (computed.textAlign.toUpperCase() || 'LEFT');
  }
  const borderColor = parseColor(computed.borderColor);
  if (borderColor && computed.borderWidth && computed.borderWidth !== '0px') {
    node.strokes = [{ type: 'SOLID', color: borderColor.color, opacity: borderColor.opacity }];
    node.strokeWeight = parseFloat(computed.borderWidth) || 1;
  }
  const radius = parseBorderRadius(computed);
  if (radius.tl > 0) { node.topLeftRadius = radius.tl; node.topRightRadius = radius.tr; node.bottomLeftRadius = radius.bl; node.bottomRightRadius = radius.br; }
  const shadow = parseShadow(computed.boxShadow);
  if (shadow) node.effects = [shadow];
  const childElements = Array.from(el.children).filter(c => c instanceof HTMLElement && !['SCRIPT','STYLE','NOSCRIPT'].includes(c.tagName)) as HTMLElement[];
  if (childElements.length > 0 && type !== 'TEXT') {
    const children: SceneNode[] = [];
    for (const child of childElements) { const childNode = extractNode(child); if (childNode) children.push(childNode); }
    if (children.length > 0) node.children = children;
  }
  return node;
}

function countNodes(node: SceneNode | null): number {
  if (!node) return 0;
  let count = 1;
  if (node.children) { for (const child of node.children) count += countNodes(child); }
  return count;
}

// ─── Main Handler ───
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const requestStart = Date.now();
  console.log(`\n=== New request at ${new Date().toISOString()} ===`);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, props = {}, css = '' } = req.body;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Missing code' });
  }
  if (code.length > 50000) {
    return res.status(413).json({ error: 'Code too large (max 50KB)' });
  }

  let browser: any = null;
  let page: any = null;

  try {
    // ─── Step 1: Compile JSX ───
    const step1 = Date.now();
    const transformResult = await esbuild.transform(code, {
      loader: 'tsx',
      jsx: 'transform',
      format: 'iife',
      globalName: 'ComponentBundle',
      target: 'es2020',
      minify: true,
    });
    t('esbuild compile', step1);

    if (transformResult.errors.length > 0) {
      return res.status(400).json({
        error: 'Compilation failed',
        details: transformResult.errors,
      });
    }

    // ─── Step 2: Get browser from pool ───
    const step2 = Date.now();
    browser = await getBrowser();
    t('browserless connect', step2);

    // ─── Step 3: Create new page ───
    page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });

    // ─── Step 4: Build HTML with inline React (no CDN fetch) ───
    const step3 = Date.now();
    const html = `<!DOCTYPE html><html><head>
  <meta charset="UTF-8">
  <script>${REACT_SCRIPT}</script>
  <script>${REACT_DOM_SCRIPT}</script>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:transparent;}
    #root{display:flex;min-height:100vh;align-items:flex-start;justify-content:flex-start;}
    ${css}
  </style>
</head><body>
  <div id="root" data-extract-root></div>
  <script>
    ${transformResult.code}
    var Component=ComponentBundle.default||Object.values(ComponentBundle)[0];
    var props=${JSON.stringify(props)};
    var root=ReactDOM.createRoot(document.getElementById('root'));
    root.render(React.createElement(Component,props));
  </script>
</body></html>`;

    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-extract-root] > *', { timeout: 8000 });
    t('page render', step3);

    // ─── Step 5: Extract scene ───
    const step4 = Date.now();
    const scene = await page.evaluate(() => {
      const root = document.querySelector('[data-extract-root]') as HTMLElement;
      if (!root) return { __error: 'No [data-extract-root] found' };
      if (!root.firstElementChild) return { __error: 'Component rendered empty' };

      function parseColor(color: string): any {
        if (!color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return null;
        const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (rgbMatch) return { color: { r: parseInt(rgbMatch[1])/255, g: parseInt(rgbMatch[2])/255, b: parseInt(rgbMatch[3])/255 }, opacity: 1 };
        const rgbaMatch = color.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
        if (rgbaMatch) return { color: { r: parseInt(rgbaMatch[1])/255, g: parseInt(rgbaMatch[2])/255, b: parseInt(rgbaMatch[3])/255 }, opacity: parseFloat(rgbaMatch[4]) };
        const hexMatch = color.match(/#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?/);
        if (hexMatch) {
          const hex = hexMatch[1];
          const alpha = hexMatch[2] ? parseInt(hexMatch[2], 16)/255 : 1;
          return { color: { r: parseInt(hex.slice(0,2),16)/255, g: parseInt(hex.slice(2,4),16)/255, b: parseInt(hex.slice(4,6),16)/255 }, opacity: alpha };
        }
        const namedColors: Record<string,string> = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff' };
        if (namedColors[color.toLowerCase()]) return parseColor(namedColors[color.toLowerCase()]);
        return null;
      }

      function parseShadow(shadow: string): any | null {
        if (!shadow || shadow === 'none') return null;
        const firstShadow = shadow.split(',')[0].trim();
        const match = firstShadow.match(/([\d.-]+px)\s+([\d.-]+px)\s+([\d.-]+px)\s*(?:([\d.-]+px)\s*)?(rgba?\([^)]+\)|#[0-9a-fA-F]+|\w+)/);
        if (!match) return null;
        const [, xStr, yStr, blurStr, spreadStr, colorStr] = match;
        const color = parseColor(colorStr);
        if (!color) return null;
        return { type: 'DROP_SHADOW', color: { ...color.color, a: color.opacity }, offset: { x: parseFloat(xStr), y: parseFloat(yStr) }, radius: parseFloat(blurStr), spread: spreadStr ? parseFloat(spreadStr) : 0, visible: true };
      }

      function parseBorderRadius(computed: CSSStyleDeclaration) {
        const parse = (val: string) => { const n = parseFloat(val); return isNaN(n) ? 0 : n; };
        const all = parse(computed.borderRadius);
        if (all > 0 && computed.borderTopLeftRadius === computed.borderRadius) return { tl: all, tr: all, bl: all, br: all };
        return { tl: parse(computed.borderTopLeftRadius), tr: parse(computed.borderTopRightRadius), bl: parse(computed.borderBottomLeftRadius), br: parse(computed.borderBottomRightRadius) };
      }

      function detectLayout(computed: CSSStyleDeclaration) {
        if (computed.display !== 'flex' && computed.display !== 'inline-flex') return null;
        const isRow = computed.flexDirection === 'row' || computed.flexDirection === 'row-reverse';
        const justifyMap: Record<string, any> = { 'flex-start': 'MIN', start: 'MIN', center: 'CENTER', 'flex-end': 'MAX', end: 'MAX', 'space-between': 'SPACE_BETWEEN', 'space-around': 'SPACE_BETWEEN', 'space-evenly': 'SPACE_BETWEEN' };
        const alignMap: Record<string, any> = { 'flex-start': 'MIN', start: 'MIN', center: 'CENTER', 'flex-end': 'MAX', end: 'MAX', stretch: 'MIN' };
        return { layoutMode: isRow ? 'HORIZONTAL' : 'VERTICAL', itemSpacing: parseFloat(computed.gap) || 0, paddingTop: parseFloat(computed.paddingTop) || 0, paddingBottom: parseFloat(computed.paddingBottom) || 0, paddingLeft: parseFloat(computed.paddingLeft) || 0, paddingRight: parseFloat(computed.paddingRight) || 0, primaryAxisAlign: justifyMap[computed.justifyContent] || 'MIN', counterAxisAlign: alignMap[computed.alignItems] || 'MIN' };
      }

      function parseFont(computed: CSSStyleDeclaration) {
        const family = computed.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
        const weight = computed.fontWeight;
        let style = 'Regular';
        if (weight === '700' || weight === 'bold') style = 'Bold';
        else if (weight === '600') style = 'SemiBold';
        else if (weight === '500') style = 'Medium';
        else if (weight === '300' || weight === 'lighter') style = 'Light';
        if (computed.fontStyle === 'italic') style = style === 'Regular' ? 'Italic' : `${style} Italic`;
        let lineHeight: any; const lh = computed.lineHeight; if (lh === 'normal') lineHeight = { value: 120, unit: 'PERCENT' }; else if (lh.endsWith('px')) lineHeight = { value: parseFloat(lh), unit: 'PIXELS' }; else lineHeight = { value: parseFloat(lh)*100 || 120, unit: 'PERCENT' };
        let letterSpacing: any; const ls = computed.letterSpacing; if (ls === 'normal') letterSpacing = { value: 0, unit: 'PIXELS' }; else if (ls.endsWith('px')) letterSpacing = { value: parseFloat(ls), unit: 'PIXELS' }; else letterSpacing = { value: parseFloat(ls) || 0, unit: 'PIXELS' };
        let textCase: any = 'ORIGINAL'; if (computed.textTransform === 'uppercase') textCase = 'UPPER'; else if (computed.textTransform === 'lowercase') textCase = 'LOWER'; else if (computed.textTransform === 'capitalize') textCase = 'TITLE';
        return { fontName: { family: family || 'Inter', style }, fontSize: parseFloat(computed.fontSize) || 16, lineHeight, letterSpacing, textCase };
      }

      function extractNode(el: HTMLElement): any {
        const computed = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (computed.display === 'none' || computed.visibility === 'hidden') return null;
        let type = 'FRAME';
        let name = el.tagName.toLowerCase();
        if (el.tagName === 'IMG') { type = 'RECTANGLE'; name = 'Image'; }
        else if (el.children.length === 0 && el.textContent?.trim()) { type = 'TEXT'; name = el.textContent.trim().slice(0, 20) || 'Text'; }
        else if (el.tagName === 'BUTTON') name = 'Button';
        const testId = el.getAttribute('data-testid');
        if (testId) name = testId;
        const node: any = { type, name, x: Math.round(rect.left*100)/100, y: Math.round(rect.top*100)/100, width: Math.round(rect.width*100)/100, height: Math.round(rect.height*100)/100 };
        if (node.width === 0 || node.height === 0) return null;
        const layout = detectLayout(computed);
        if (layout) Object.assign(node, layout);
        const bgColor = parseColor(computed.backgroundColor);
        if (bgColor) node.fills = [{ type: 'SOLID', color: bgColor.color, opacity: bgColor.opacity }];
        if (type === 'TEXT') {
          const fgColor = parseColor(computed.color);
          if (fgColor) node.fills = [{ type: 'SOLID', color: fgColor.color, opacity: fgColor.opacity }];
          const fontInfo = parseFont(computed);
          Object.assign(node, fontInfo);
          node.characters = el.textContent?.trim() || '';
          node.textAlignHorizontal = (computed.textAlign.toUpperCase() || 'LEFT');
        }
        const borderColor = parseColor(computed.borderColor);
        if (borderColor && computed.borderWidth && computed.borderWidth !== '0px') {
          node.strokes = [{ type: 'SOLID', color: borderColor.color, opacity: borderColor.opacity }];
          node.strokeWeight = parseFloat(computed.borderWidth) || 1;
        }
        const radius = parseBorderRadius(computed);
        if (radius.tl > 0) { node.topLeftRadius = radius.tl; node.topRightRadius = radius.tr; node.bottomLeftRadius = radius.bl; node.bottomRightRadius = radius.br; }
        const shadow = parseShadow(computed.boxShadow);
        if (shadow) node.effects = [shadow];
        const childElements = Array.from(el.children).filter(c => c instanceof HTMLElement && !['SCRIPT','STYLE','NOSCRIPT'].includes(c.tagName)) as HTMLElement[];
        if (childElements.length > 0 && type !== 'TEXT') {
          const children: any[] = [];
          for (const child of childElements) { const childNode = extractNode(child); if (childNode) children.push(childNode); }
          if (children.length > 0) node.children = children;
        }
        return node;
      }

      return extractNode(root);
    });
    t('DOM extraction', step4);

    // ─── Step 6: Cleanup page (keep browser connection alive) ───
    await page.close();
    t('total request', requestStart);

    if (scene && scene.__error) {
      return res.status(400).json({ error: scene.__error });
    }
    if (!scene) {
      return res.status(400).json({ error: 'Extraction returned empty scene' });
    }

    return res.status(200).json({
      success: true,
      scene,
      stats: {
        nodeCount: countNodes(scene),
        duration: Date.now() - requestStart,
      },
    });

  } catch (err: any) {
    if (page) { try { await page.close(); } catch {} }
    console.error('Extraction error:', err);
    t('failed request', requestStart);
    return res.status(500).json({
      error: 'Extraction failed',
      message: err.message,
    });
  }
}