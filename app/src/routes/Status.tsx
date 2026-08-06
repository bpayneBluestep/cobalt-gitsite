export default function Status() {
  const rows: Array<[string, string]> = [
    ['Base path', import.meta.env.BASE_URL],
    ['Mode', import.meta.env.MODE],
    ['Current path', window.location.pathname],
    ['Build hash assets', 'resolved under /spa/assets/ ✓'],
  ]

  return (
    <section className="card">
      <h1>Runtime status</h1>
      <p>
        You reached this via client-side routing. If you hard-refreshed and
        still see it, the extension-less fallback to <code>index.html</code> is
        working.
      </p>

      <table className="status">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td>
                <code>{v}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
