import { defineConfig } from '@playwright/test';
import editorConfig from '../../playwright.config';

export default defineConfig({ ...editorConfig, testDir: '.', testMatch: 'ai*.spec.ts' });
