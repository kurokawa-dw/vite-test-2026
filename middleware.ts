export const config = {
  matcher: '/:path*', // 全てのルートに適用
};

const USERNAME = process.env.BASIC_AUTH_USERNAME || '';
const PASSWORD = process.env.BASIC_AUTH_PASSWORD || '';

export default function middleware(req: Request) {
  const authHeader = req.headers.get('authorization');

  if (!authHeader) {
    return new Response('Unauthorized', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Secure Area"',
      },
    });
  }

  const encoded = authHeader.split(' ')[1];
  const decoded = atob(encoded); // デコードして username:password の形式を取得
  const [user, pass] = decoded.split(':');

  if (user !== USERNAME || pass !== PASSWORD) {
    return new Response('Unauthorized', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Secure Area"',
      },
    });
  }

  // 認証成功時はリクエストをそのまま通す
  return undefined; // Vercel Middleware では `undefined` を返すとリクエストを継続
}
