/**
 * Ant Design 主题。
 *
 * 为了让 theme.scss 成为唯一事实来源，这里在运行期读取 CSS 变量，
 * 而不是在 TS 里重复写一遍颜色值。切换主题时重新计算即可。
 */

import { theme as antdTheme, type ThemeConfig } from 'antd';

export type ThemeName = 'cream' | 'white' | 'dark';

export const THEME_STORAGE_KEY = 'parrot-webui:theme';

export const THEME_OPTIONS: Array<{ value: ThemeName; label: string }> = [
  { value: 'cream', label: '纸感米色' },
  { value: 'white', label: '纯白' },
  { value: 'dark', label: '暖炭黑' },
];

function readVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function isThemeName(value: unknown): value is ThemeName {
  return value === 'cream' || value === 'white' || value === 'dark';
}

/** 读取用户上次选择；不存在时跟随系统深色偏好。 */
export function readStoredTheme(): ThemeName {
  if (typeof window === 'undefined') return 'cream';
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeName(stored)) return stored;
  } catch {
    // 隐私模式下 localStorage 可能不可用，忽略即可
  }
  if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'cream';
}

export function applyThemeAttribute(name: ThemeName): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = name;
}

export function storeTheme(name: ThemeName): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, name);
  } catch {
    // 忽略存储失败：主题仍在本会话生效
  }
}

/** 依据当前 CSS 变量生成 Ant Design 主题令牌。 */
export function buildAntdTheme(name: ThemeName): ThemeConfig {
  const radius = Number.parseInt(readVar('--radius-md', '8'), 10) || 8;
  return {
    algorithm: name === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: readVar('--primary-color', '#8b8680'),
      colorInfo: readVar('--primary-color', '#8b8680'),
      colorSuccess: readVar('--success-color', '#10b981'),
      colorWarning: readVar('--quota-medium-color', '#e0aa14'),
      colorError: readVar('--error-color', '#c65746'),
      colorBgBase: readVar('--bg-secondary', '#faf9f5'),
      colorBgContainer: readVar('--bg-primary', '#f0eee8'),
      colorBgElevated: readVar('--floating-surface', '#fffdf9'),
      colorText: readVar('--text-primary', '#2d2a26'),
      colorTextSecondary: readVar('--text-secondary', '#6d6760'),
      colorTextTertiary: readVar('--text-tertiary', '#a29c95'),
      colorBorder: readVar('--border-color', '#e3e1db'),
      colorBorderSecondary: readVar('--border-color', '#e3e1db'),
      borderRadius: radius,
      borderRadiusLG: 12,
      controlHeight: 36,
      fontSize: 12,
      fontFamily: readVar('--keeper-font-family', "'Segoe UI', sans-serif"),
      boxShadowSecondary: readVar('--shadow-lg', '0 10px 18px -3px rgb(0 0 0 / 0.1)'),
    },
    components: {
      Table: {
        headerBg: readVar('--bg-secondary', '#faf9f5'),
        rowHoverBg: readVar('--bg-tertiary', '#e9e6df'),
        borderColor: readVar('--border-color', '#e3e1db'),
        cellPaddingBlock: 10,
      },
      Drawer: {
        colorBgElevated: readVar('--bg-primary', '#f0eee8'),
      },
      Modal: {
        contentBg: readVar('--bg-primary', '#f0eee8'),
        headerBg: readVar('--bg-primary', '#f0eee8'),
      },
      Select: { optionSelectedBg: readVar('--bg-hover', '#e9e6df') },
    },
  };
}
