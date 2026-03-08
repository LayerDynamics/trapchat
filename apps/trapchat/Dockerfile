FROM node:20-alpine@sha256:5bac2112f1a27db4775ce6ead86db9e0cbc087f0dbddfe3cbc11ecea122d5294 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine@sha256:c032460d1fd73978317479ba23c37bcb57d93156cab122eb3c54b8e4bdc292fa
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chown -R nginx:nginx /var/cache/nginx && \
    chown -R nginx:nginx /var/log/nginx && \
    touch /var/run/nginx.pid && chown nginx:nginx /var/run/nginx.pid
USER nginx
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
