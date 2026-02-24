/**
 * ESLint Flat Configuration
 * @see https://eslint.org/docs/latest/use/configure/configuration-files
 */

module.exports = [
    {
        ignores: [
            'node_modules/**',
            'dist/**',
            '*.vsix',
            '*.bat',
            'main_scripts/auto_accept.js'  // Legacy browser-only ES module, not part of the build
        ]
    },
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: {
                // Browser globals
                window: 'readonly',
                document: 'readonly',
                navigator: 'readonly',
                console: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                fetch: 'readonly',
                WebSocket: 'readonly',
                localStorage: 'readonly',
                sessionStorage: 'readonly',
                MutationObserver: 'readonly',
                IntersectionObserver: 'readonly',
                ShadowRoot: 'readonly',
                Element: 'readonly',
                HTMLElement: 'readonly',
                Event: 'readonly',
                CustomEvent: 'readonly',
                JSON: 'readonly',
                Object: 'readonly',
                Array: 'readonly',
                String: 'readonly',
                Number: 'readonly',
                Boolean: 'readonly',
                Date: 'readonly',
                RegExp: 'readonly',
                Error: 'readonly',
                TypeError: 'readonly',
                Promise: 'readonly',
                Symbol: 'readonly',
                Map: 'readonly',
                Set: 'readonly',
                WeakMap: 'readonly',
                WeakSet: 'readonly',
                Proxy: 'readonly',
                Reflect: 'readonly',
                parseInt: 'readonly',
                parseFloat: 'readonly',
                isNaN: 'readonly',
                isFinite: 'readonly',
                encodeURIComponent: 'readonly',
                decodeURIComponent: 'readonly',
                // Node.js globals
                global: 'readonly',
                globalThis: 'readonly',
                process: 'readonly',
                Buffer: 'readonly',
                require: 'readonly',
                module: 'readonly',
                exports: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                URL: 'readonly',
                URLSearchParams: 'readonly'
            }
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-unused-expressions': 'warn'
        }
    }
];
