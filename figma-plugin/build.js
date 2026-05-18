const esbuild = require('esbuild');
const fs = require('fs');

const watch = process.argv.includes('--watch');

async function buildUi() {
  const result = await esbuild.build({
    bundle: true,
    platform: 'browser',
    target: 'es6',
    format: 'iife',
    entryPoints: ['src/ui.ts'],
    write: false,
    logLevel: 'silent',
  });
  const js = Buffer.from(result.outputFiles[0].contents).toString('utf-8');
  const template = fs.readFileSync('ui.html', 'utf-8');
  const output = template.replace('<script src="ui.js"></script>', `<script>${js}</script>`);
  fs.mkdirSync('dist', { recursive: true });
  fs.writeFileSync('dist/ui.html', output);
  console.log('[build] dist/ui.html');
}

async function main() {
  fs.mkdirSync('dist', { recursive: true });

  if (watch) {
    const codeCtx = await esbuild.context({
      bundle: true, platform: 'browser', target: 'es6',
      entryPoints: ['src/code.ts'],
      outfile: 'dist/code.js',
      logLevel: 'info',
    });
    await codeCtx.watch();

    await buildUi();
    fs.watch('src/ui.ts', () => buildUi().catch(console.error));
    fs.watch('ui.html', () => buildUi().catch(console.error));
    console.log('[watch] ui.ts + ui.html');
  } else {
    await esbuild.build({
      bundle: true, platform: 'browser', target: 'es6',
      entryPoints: ['src/code.ts'],
      outfile: 'dist/code.js',
    });
    console.log('[build] dist/code.js');
    await buildUi();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
