export default function LiveVideo({ frame }: { frame: string | null }) {
  return (
    <div className="card">
      <h2>Video en vivo</h2>
      {frame ? (
        <img className="video" src={`data:image/jpeg;base64,${frame}`} alt="Transmisión del dron" />
      ) : (
        <div className="video placeholder">Sin señal de video</div>
      )}
    </div>
  );
}
