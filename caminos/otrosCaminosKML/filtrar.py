import os
import re

# =====================================================================
# LÍMITES APROXIMADOS DE LOS PIRINEOS (Bounding Box)
# Puedes ajustar estos valores si quieres ser más estricto o permisivo.
# =====================================================================
MIN_LON = -2.5  # OESTE: Cerca de San Sebastián / Pamplona
MAX_LON = 3.5   # ESTE: Cap de Creus / Mediterráneo
MIN_LAT = 41.8  # SUR: Prepirineo (Norte de Cataluña/Aragón/Navarra)
MAX_LAT = 43.5  # NORTE: Pirineo Francés

def is_in_pyrenees(lon, lat):
    """Comprueba si un punto cae dentro del recuadro de los Pirineos."""
    return (MIN_LON <= lon <= MAX_LON) and (MIN_LAT <= lat <= MAX_LAT)

def procesar_kmls():
    # Listar todos los archivos KML en la carpeta actual
    kml_files = [f for f in os.listdir('.') if f.endswith('.kml') or f.endswith('.KML')]
    total_files = len(kml_files)
    archivos_borrados = 0
    
    if total_files == 0:
        print("No se han encontrado archivos KML en esta carpeta.")
        return

    print(f"Se han encontrado {total_files} archivos KML.")
    print("Iniciando filtrado. Esto puede tardar un poco...")
    
    for idx, filename in enumerate(kml_files):
        mantener_archivo = False
        
        try:
            # Leer el KML. Usamos 'ignore' para evitar bloqueos si hay algún carácter raro
            with open(filename, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
                
            # Extraer rápidamente todo el contenido dentro de las etiquetas <coordinates>
            bloques_coordenadas = re.findall(r'<coordinates>(.*?)</coordinates>', content, re.DOTALL)
            
            for bloque in bloques_coordenadas:
                # Los puntos están separados por espacios en blanco o saltos de línea
                puntos = bloque.strip().split()
                
                for punto in puntos:
                    # Separar la longitud y la latitud (ej: 0.738,42.407 o 0.738,42.407,alt)
                    partes = punto.split(',')
                    if len(partes) >= 2:
                        try:
                            lon = float(partes[0])
                            lat = float(partes[1])
                            
                            if is_in_pyrenees(lon, lat):
                                mantener_archivo = True
                                break # ¡Encontrado! Dejamos de mirar más puntos de este bloque
                        except ValueError:
                            continue # Si un punto tiene mal formato, lo ignoramos y pasamos al siguiente
                
                if mantener_archivo:
                    break # Dejamos de mirar más bloques de coordenadas de este archivo
                    
        except Exception as e:
            print(f"Error procesando {filename}: {e}")
            continue
            
        # Si después de mirar todo no encontramos ninguna coordenada en los Pirineos, lo borramos
        if not mantener_archivo:
            try:
                os.remove(filename)
                archivos_borrados += 1
            except Exception as e:
                print(f"No se pudo borrar {filename}: {e}")
            
        # Imprimir progreso cada 100 archivos para que veas que el programa sigue vivo
        if (idx + 1) % 100 == 0:
            print(f"Progreso: {idx + 1} / {total_files} archivos analizados...")

    # Resultados
    print("\n--- RESUMEN DEL FILTRADO ---")
    print(f"Archivos analizados inicialmente: {total_files}")
    print(f"Archivos ELIMINADOS (Fuera del Pirineo): {archivos_borrados}")
    print(f"Archivos CONSERVADOS (Dentro del Pirineo): {total_files - archivos_borrados}")

if __name__ == "__main__":
    procesar_kmls()