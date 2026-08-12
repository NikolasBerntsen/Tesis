import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: process.env.JWT_SECRET ?? 'secreto-dev-cambiar',
  dbFile: process.env.DB_FILE ?? './data/comando-central.db',
  // Sesión de consola (operador, supervisor, admin)
  tokenTtl: '12h',
  // Sesión efímera del operador de campo: alcanza para dar de alta un dron y
  // emparejarlo, y se cierra sola si el celular queda dado vuelta en el predio.
  tokenTtlField: '20m',
  // Token de máquina del dron: se emite una vez al emparejar por QR y tiene que
  // sobrevivir a todo un despliegue sin que nadie vuelva a tocar el celular.
  tokenTtlDrone: '30d',
};
