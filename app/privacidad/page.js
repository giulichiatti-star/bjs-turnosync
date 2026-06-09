export default function Privacidad() {
  return (
    <div style={{ background: '#0a0f1e', minHeight: '100vh', color: '#f0f4ff', fontFamily: 'Inter, sans-serif', padding: '48px 24px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ marginBottom: 32 }}>
          <a href="/" style={{ color: '#48b4e0', textDecoration: 'none', fontSize: 13 }}>← Volver a la app</a>
        </div>
        <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 4 }}><span style={{ color: '#48b4e0' }}>BJS</span> TurnoSync</h1>
        <h2 style={{ fontSize: 18, fontWeight: 600, color: '#6b8099', marginBottom: 32 }}>Política de Privacidad y Protección de Datos</h2>

        {[
          ['1. Responsable del tratamiento', `BJS Legal Services España es el responsable del tratamiento de los datos personales recogidos a través de la aplicación BJS TurnoSync.\n\nContacto: admin@bjslegal.com`],
          ['2. Datos que tratamos', `Tratamos los siguientes datos personales de los empleados:\n• Nombre y apellidos\n• Dirección de correo electrónico\n• Número de teléfono (opcional)\n• Información de turnos de trabajo y ausencias\n• Registros de actividad disciplinaria (solo administradores)`],
          ['3. Finalidad del tratamiento', `Los datos se tratan exclusivamente para:\n• Gestión y planificación de turnos de trabajo\n• Comunicación interna sobre cambios de turno y ausencias\n• Generación de estadísticas internas de presencia`],
          ['4. Base jurídica (Art. 6 RGPD)', `El tratamiento se basa en:\n• Ejecución del contrato laboral (Art. 6.1.b RGPD)\n• Interés legítimo del empleador en la organización del trabajo (Art. 6.1.f RGPD)`],
          ['5. Localización de los datos', `Todos los datos se almacenan en servidores ubicados en la Unión Europea (Irlanda, región eu-west-1), cumpliendo con los requisitos de transferencia del RGPD.`],
          ['6. Plazo de conservación', `Los datos de turnos se conservan durante el año en curso más 2 años adicionales, conforme a la normativa laboral española. Los datos disciplinarios se conservan según lo estipulado en el convenio colectivo aplicable.`],
          ['7. Derechos del interesado (Arts. 15-22 RGPD)', `Tienes derecho a:\n• Acceso a tus datos personales\n• Rectificación de datos inexactos\n• Supresión (derecho al olvido, Art. 17) — disponible desde el panel de la app\n• Portabilidad de los datos\n• Oposición al tratamiento\n\nPara ejercer tus derechos, contacta a: admin@bjslegal.com`],
          ['8. Seguridad', `Aplicamos medidas técnicas y organizativas adecuadas para proteger los datos:\n• Autenticación con contraseña cifrada (Supabase Auth)\n• Comunicaciones cifradas (HTTPS/TLS)\n• Acceso restringido por roles (administrador / agente)`],
          ['9. Cambios en esta política', `Cualquier modificación será notificada con al menos 30 días de antelación a través de la aplicación.`],
          ['10. Autoridad de control', `Si consideras que el tratamiento de tus datos no es adecuado, puedes presentar una reclamación ante la Agencia Española de Protección de Datos (AEPD): www.aepd.es`],
        ].map(([title, body], i) => (
          <div key={i} style={{ marginBottom: 28, paddingBottom: 28, borderBottom: '1px solid #1e2d45' }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8, color: '#48b4e0' }}>{title}</h3>
            <p style={{ fontSize: 13, color: '#a1b4cc', lineHeight: 1.8, whiteSpace: 'pre-line', margin: 0 }}>{body}</p>
          </div>
        ))}

        <div style={{ fontSize: 11, color: '#6b8099', marginTop: 16 }}>
          Última actualización: junio 2026 · BJS TurnoSync v1.0
        </div>
      </div>
    </div>
  );
}
