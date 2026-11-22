import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({ base: '/poker-trainer/', plugins: [react(), VitePWA({ registerType: 'prompt', includeAssets: ['icon-192.png','icon-512.png'], manifest: { name: 'Poker Trainer', short_name: 'Poker Trainer', theme_color: '#101820', background_color: '#101820', display: 'standalone', icons: [{src:'icon-192.png',sizes:'192x192',type:'image/png'}, {src:'icon-512.png',sizes:'512x512',type:'image/png'}] } })] });
