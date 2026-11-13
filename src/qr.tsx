import { encode } from 'uqr'

/** The path of a QR code's dark squares, one unit each, and its width in units, border included. */
export function qrPath(text: string): { path: string; size: number } {
  const { data, size } = encode(text, { ecc: 'M', border: 4 })
  let path = ''
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`
    })
  })
  return { path, size }
}

/**
 * A QR code, drawn on the server as SVG: what it holds, an app's secret, never goes to another
 * service to be drawn. Dark on white whatever the page's colours, so cameras read it.
 */
export function QrCode({
  text,
  label,
  pixels = 200,
}: {
  text: string
  label: string
  pixels?: number
}) {
  const { path, size } = qrPath(text)
  return (
    <svg
      className="otp-qr"
      role="img"
      aria-label={label}
      width={pixels}
      height={pixels}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}
