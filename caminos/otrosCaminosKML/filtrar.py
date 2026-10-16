import os
import re

# =====================================================================
# LÍMITES ESTRICTOS DE LOS PIRINEOS
# Ajustados para cortar en el Cap de Creus y evitar el Mediterráneo
# =====================================================================
MIN_LON = -2.5   # OESTE: Navarra / País Vasco
MAX_LON = 3.35   # ESTE: Cap de Creus (Corte estricto antes del mar)
MIN_LAT = 41.9   # SUR: Prepirineo estricto (Huesca/Lleida/Gerona altas)
MAX_LAT = 43.5   # NORTE: Pirineo Francés

# =====================================================================
# UMBRAL DE EXIGENCIA
# Porcentaje mínimo de coordenadas que deben estar dentro del Pirineo.
# 0.40 significa que al menos el 40% del camino tiene que ser pirenaico.
# =====================================================================
UMBRAL_PORCENTAJE = 0.40

def is_in_pyrenees(lon, lat):
    """Comprueba si un punto cae dentro del recuadro de los Pirineos."""
    return (MIN_LON <= lon <= MAX_LON) and (MIN_LAT <= lat <= MAX_LAT)

def procesar_kmls():
    kml_files = [f for f in os.listdir('.') if f.endswith('.kml') or f.endswith('.KML')]
    total_files = len(kml_files)
    archivos_borrados = 0
    
    if total_files == 0:
        print("No se han encontrado archivos KML en esta carpeta.")
        return

    print(f"Iniciando filtrado de {total_files} archivos...")
    print(f"Exigencia: Al menos el {UMBRAL_PORCENTAJE * 100}% del recorrido debe estar en los Pirineos.")
    
    for idx, filename in enumerate(kml_files):
        puntos_totales = 0
        puntos_en_pirineo = 0
        
        try:
            with open(filename, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
                
            bloques_coordenadas = re.findall(r'<coordinates>(.*?)</coordinates>', content, re.DOTALL)
            
            # Contar los puntos dentro y fuera
            for bloque in bloques_coordenadas:
                puntos = bloque.strip().split()
                
                for punto in puntos:
                    partes = punto.split(',')
                    if len(partes) >= 2:
                        try:
                            lon = float(partes[0])
                            lat = float(partes[1])
                            puntos_totales += 1
                            
                            if is_in_pyrenees(lon, lat):
                                puntos_en_pirineo += 1
                        except ValueError:
                            continue
                            
        except Exception as e:
            print(f"Error procesando {filename}: {e}")
            continue
            
        # Evaluar si el archivo cumple con la densidad de puntos requerida
        mantener_archivo = False
        if puntos_totales > 0:
            porcentaje_real = puntos_en_pirineo / puntos_totales
            if porcentaje_real >= UMBRAL_PORCENTAJE:
                mantener_archivo = True
                
        # Borrar si no llega al mínimo o si estaba vacío
        if not mantener_archivo:
            try:
                os.remove(filename)
                archivos_borrados += 1
            except Exception as e:
                print(f"No se pudo borrar {filename}: {e}")
            
        if (idx + 1) % 100 == 0:
            print(f"Progreso: {idx + 1} / {total_files} archivos analizados...")

    print("\n--- RESUMEN DEL FILTRADO POR PORCENTAJE ---")
    print(f"Archivos analizados: {total_files}")
    print(f"Archivos ELIMINADOS (No llegan al {UMBRAL_PORCENTAJE*100}%): {archivos_borrados}")
    print(f"Archivos CONSERVADOS (Rutas predominantemente pirenaicas): {total_files - archivos_borrados}")

if __name__ == "__main__":
    procesar_kmls()