FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY core/ core/
COPY headless/ headless/
RUN dotnet publish headless/Slopterm.Headless.csproj \
    --configuration Release \
    --output /out \
    --no-self-contained

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /out/ ./
USER $APP_UID
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
    CMD ["dotnet", "Slopterm.Headless.dll", "--healthcheck"]
ENTRYPOINT ["dotnet", "Slopterm.Headless.dll"]
