// api/check-password.js
export default function handler(req, res) {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD; // Vercel 환경 변수에서 가져옴

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  if (password === adminPassword) {
    return res.status(200).json({ success: true });
  } else {
    return res.status(401).json({ success: false, message: '비밀번호가 틀렸습니다.' });
  }
}
