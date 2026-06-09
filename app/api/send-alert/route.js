import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(request) {
  try {
    const { to, subject, html } = await request.json();

    if (!to || !subject || !html) {
      return Response.json({ error: 'Faltan campos obligatorios' }, { status: 400 });
    }

    const { data, error } = await resend.emails.send({
      from: 'BJS TurnoSync <onboarding@resend.dev>',
      to,
      subject,
      html,
    });

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ success: true, id: data.id });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
