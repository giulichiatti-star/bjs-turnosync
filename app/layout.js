import './globals.css'

export const metadata = {
  title: 'BJS TurnoSync',
  description: 'Gestión de turnos y cronogramas — BJS Legal Services España',
}

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <head>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  )
}
