Only needed when you want to CHANGE the page's design or text (you can ignore this folder otherwise).

1. Install Node.js, then in this folder run:   npm ci      (installs the exact versions in package-lock.json)
2. Edit src/template.html (page layout/text) or src/app.js (behaviour)
3. Run:   npm run build
4. Copy the new files from dist/ (index.html, _headers, assets/) to the repo root and delete the old assets/app.*.js file
   (the file name changes every build).
