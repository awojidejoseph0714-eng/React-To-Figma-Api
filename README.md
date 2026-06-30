# React-to-Figma Cloud API

Serverless API that compiles JSX/TSX, renders in headless Chromium, returns Figma scene JSON.

## Deploy

```bash
npm i -g vercel
vercel env add AWS_LAMBDA_JS_RUNTIME   # value: nodejs22.x
vercel --prod
```

## Usage

```bash
curl -X POST https://api.react-to-figma.vercel.app/api/extract \
  -H "Content-Type: application/json" \
  -d '{"code":"export default function Card(){return <div style={{padding:20}}>Hello</div>;}","props":{},"css":""}'
```

## Troubleshooting

| Error | Fix |
|-------|-----|
| Chromium not found | Set `AWS_LAMBDA_JS_RUNTIME=nodejs22.x` |
| Timeout | Increase `maxDuration` in vercel.json |
