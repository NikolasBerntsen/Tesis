import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: process.env.JWT_SECRET ?? 'secreto-dev-cambiar',
  dbFile: process.env.DB_FILE ?? './data/comando-central.db',
  /*
   * Quién puede llamar a la API desde un navegador. Antes esto era `cors()` a
   * secas, que responde `Access-Control-Allow-Origin: *`: cualquier página
   * abierta en la máquina del operador podía pegarle a la API del sistema de
   * patrullaje. En producción el backend sirve la consola desde su mismo
   * origen y en desarrollo Vite hace de proxy, así que la lista de abajo
   * alcanza; se cambia con CORS_ORIGINS (separados por coma), y `*` vuelve al
   * comportamiento viejo si alguna vez hace falta a propósito.
   *
   * No afecta a la app Android: un cliente nativo no aplica CORS.
   */
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  // Sesión de consola (operador, supervisor, admin)
  tokenTtl: '12h',
  // Sesión efímera del operador de campo: alcanza para dar de alta un dron y
  // emparejarlo, y se cierra sola si el celular queda dado vuelta en el predio.
  tokenTtlField: '20m',
  // Token de máquina del dron: se emite una vez al emparejar por QR y tiene que
  // sobrevivir a todo un despliegue sin que nadie vuelva a tocar el celular.
  tokenTtlDrone: '30d',
};
