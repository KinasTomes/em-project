# Optimized MongoDB image for Order service with replica set
FROM mongo:latest

# Generate keyfile for replica set authentication (instead of copying from host)
RUN openssl rand -base64 756 > /data/keyfile \
    && chown 999:999 /data/keyfile \
    && chmod 400 /data/keyfile

# Start MongoDB with replica set enabled
CMD ["mongod", "--replSet", "rs0", "--bind_ip_all", "--keyFile", "/data/keyfile"]