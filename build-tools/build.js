// Build: node build.js   (or: npm run build)
// src/template.html + src/app.js + src/index.html  ->  dist/
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execSync } = require('child_process');
const { compile } = require('@vue/compiler-dom');
const esbuild = require('esbuild');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
fs.rmSync(path.join(__dirname, 'dist'), { recursive: true, force: true });
fs.mkdirSync(path.join(__dirname, 'dist/assets'), { recursive: true });

// 1) Vue template -> render function (so the browser doesn't need the big template compiler)
const { code } = compile(read('src/template.html'), { mode: 'module', prefixIdentifiers: true, hoistStatic: true });
fs.writeFileSync(path.join(__dirname, 'src/render.generated.js'), code);

// 2) JavaScript bundle (runtime-only Vue + app), minified
const out = esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'src/app.js')], bundle: true, minify: true, write: false,
  format: 'esm', target: 'es2020', legalComments: 'none',
  alias: { vue: path.join(__dirname, 'node_modules/vue/dist/vue.runtime.esm-bundler.js') },
  define: { __VUE_OPTIONS_API__: 'false', __VUE_PROD_DEVTOOLS__: 'false',
            __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false', 'process.env.NODE_ENV': '"production"' },
}).outputFiles[0].text;
const hash = crypto.createHash('sha1').update(out).digest('hex').slice(0, 8);
fs.writeFileSync(path.join(__dirname, `dist/assets/app.${hash}.js`), out);

// 3) Tailwind CSS (only the classes actually used), minified, inlined into the page
execSync('npx tailwindcss -c tailwind.config.js -i src/in.css -o src/out.css --minify', { cwd: __dirname, stdio: 'pipe' });
const css = read('src/out.css');

// 4) HTML
fs.writeFileSync(path.join(__dirname, 'dist/index.html'),
  read('src/index.html').replace('/*CSS*/', () => css).split('__HASH__').join(hash));
fs.copyFileSync(path.join(__dirname, 'src/_headers'), path.join(__dirname, 'dist/_headers'));
console.log('built', { js: out.length, css: css.length, hash });
