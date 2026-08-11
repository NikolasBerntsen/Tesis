import { config } from './config';
import { createServer } from './app';

createServer().listen(config.port, () => {
  console.log(`Comando Central escuchando en http://localhost:${config.port}`);
});
