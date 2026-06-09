export async function POST(request) {
  try {
    const { imageBase64, mimeType, agents, month, year } = await request.json();

    if (!imageBase64 || !agents?.length) {
      return Response.json({ error: 'Faltan datos' }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return Response.json({ error: 'GEMINI_API_KEY no configurada' }, { status: 500 });

    const prompt = `Eres un asistente que extrae horarios de trabajo de imágenes.

Analiza esta imagen de un horario/calendario de turnos y extrae los turnos de cada agente.

Lista de agentes posibles: ${agents.join(', ')}

Mes: ${month + 1}/${year}

Reglas:
- Turno A = turno de mañana (9-17h) → devuelve "A"
- Turno B = turno de tarde (11-20h) → devuelve "B"
- Libre / descanso / día libre → devuelve "OFF"
- Ausencia / ausente → devuelve "AUS"
- Si no puedes determinar el turno de un día → omítelo

Devuelve SOLO un JSON válido con este formato exacto, sin texto adicional:
{
  "turnos": [
    { "agente": "Nombre Apellido", "dia": 1, "turno": "A" },
    { "agente": "Nombre Apellido", "dia": 2, "turno": "B" }
  ]
}

Si no puedes leer el horario claramente, devuelve: { "turnos": [], "error": "No se pudo leer el horario" }`;

    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } }
        ]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
    };

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );

    if (!res.ok) {
      const err = await res.text();
      return Response.json({ error: `Gemini error: ${err}` }, { status: 500 });
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return Response.json({ error: 'No se pudo parsear la respuesta de Gemini' }, { status: 500 });

    const result = JSON.parse(jsonMatch[0]);
    return Response.json(result);

  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
