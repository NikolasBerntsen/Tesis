export default function LiveVideo({ frame }: { frame: string | null }) {
  return (
    <div className="card">
      <h2>Video en vivo</h2>
      {/* El video se encuadra: mármol alrededor y filo dorado en el canto, como
          si la imagen fuese la abertura donde la piedra se abre. */}
      <div className="hueco filo-oro">
        {frame ? (
          <img className="video" src={`data:image/jpeg;base64,${frame}`} alt="Transmisión del dron" />
        ) : (
          <div className="video placeholder">Sin señal de video</div>
        )}
      </div>
    </div>
  );
}
