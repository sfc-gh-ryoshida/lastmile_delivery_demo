FROM ghcr.io/project-osrm/osrm-backend:v5.27.1 AS builder

RUN apt-get update && apt-get install -y wget osmium-tool && rm -rf /var/lib/apt/lists/*

WORKDIR /data

ARG OSM_URL=https://download.geofabrik.de/asia/japan/kanto-latest.osm.pbf
ARG BBOX=139.55,35.52,140.05,35.82

RUN wget -q "${OSM_URL}" -O kanto.osm.pbf && \
    osmium extract -b "${BBOX}" kanto.osm.pbf -o region.osm.pbf --overwrite && \
    rm -f kanto.osm.pbf

RUN osrm-extract -p /opt/car.lua region.osm.pbf && \
    osrm-partition region.osrm && \
    osrm-customize region.osrm && \
    rm -f region.osm.pbf

FROM ghcr.io/project-osrm/osrm-backend:v5.27.1

WORKDIR /data
COPY --from=builder /data/region.osrm* /data/

EXPOSE 5000
CMD ["osrm-routed", "--algorithm", "MLD", "--max-table-size", "200", "/data/region.osrm"]
