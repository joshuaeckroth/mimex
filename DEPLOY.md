# Deployment Guide

This repo currently maintains one first-class hosted deployment path and a few smaller distribution or self-host options.

## Deployment Targets

- AWS single-host deployment
  - Managed by Terraform in `infra/terraform`
  - Released by `scripts/aws/release.sh`
- Generic self-hosted deployment without Terraform
  - Run the built API and web server directly
  - Or build and run the Docker images yourself
- Desktop distribution
  - Electron app for local use
  - Windows installer packaging is supported
- MCP server
  - Runs over stdio for local agent/tool integration

Not currently in this repo:

- Kubernetes manifests
- Helm charts
- Docker Compose files checked into the repo root
- Render, Fly.io, Railway, Vercel, or similar platform-specific deployment configs

## AWS Deployment

This is the main hosted deployment path in the repo.

What it creates:

- One EC2 instance
- One Elastic IP
- One Route53 root `A` record
- One security group
- One IAM role and instance profile for SSM access

The release flow does not use ECR. It builds Docker images locally, ships them to the EC2 host as tar archives, loads them on the host, and starts the stack with a generated `docker-compose.yml`.

### Prerequisites

- Terraform `>= 1.14.0, < 2.0.0`
- AWS credentials already configured for your shell
- Docker with Buildx and target-platform emulation
- `git`, `ssh`, `scp`, `tar`
- An existing Route53 hosted zone
- An existing EC2 key pair if you want SSH access
- Registrar access so you can delegate the hostname to Route53

### Useful Variables

Used by `scripts/aws/plan.sh` and `scripts/aws/release.sh`:

- `AWS_REGION`
  - Default: `us-east-1`
- `HOSTED_ZONE_NAME`
  - Default: `mimex.dev`
- `CREATE_HOSTED_ZONE`
  - Default: `false`
  - Set to `true` when Terraform should create and manage the public hosted zone
- `VPC_ID`
  - Optional existing VPC; otherwise the region's default VPC is used
- `SUBNET_ID`
  - Optional existing subnet; otherwise the first subnet in the selected VPC is used
- `PROJECT_NAME`
  - Default: `mimex`
- `ENVIRONMENT`
  - Default: `prod`
- `INSTANCE_TYPE`
  - Default: `t4g.small`
- `INSTANCE_ARCH`
  - Default: `arm64`
  - Use `x86_64` for x86 instances
- `ROOT_VOLUME_SIZE_GB`
  - Default: `30`
- `SSH_KEY_NAME`
  - Required for the release script
- `SSH_CIDR`
  - Required by the release script; use the deployer's public IP with `/32`
- `DOCKER_COMPOSE_VERSION`
  - Default: `v5.0.1`
- `TF_INIT_UPGRADE`
  - Set to `true` to run `terraform init -upgrade`

Used only by `scripts/aws/release.sh`:

- `SSH_PRIVATE_KEY_PATH`
  - Required
- `BASIC_AUTH_USERNAME`
  - Default: `mimex`
- `BASIC_AUTH_PASSWORD_HASH`
  - Required; validates the login form password
- `BUILD_CONTEXT`
  - Default: repo root
- `API_DOCKERFILE`
  - Default: `apps/api/Dockerfile`
- `WEB_DOCKERFILE`
  - Default: `apps/web/Dockerfile`
- `DOCKER_BUILD_PLATFORM`
  - Defaults from `INSTANCE_ARCH`
  - `arm64` maps to `linux/arm64`
  - `x86_64` maps to `linux/amd64`
- `IMAGE_TAG`
  - Default: current git short SHA, else timestamp
- `AUTO_APPROVE`
  - Default: `false`

### Plan AWS Changes

From repo root:

```bash
export SSH_KEY_NAME=your-keypair-name
./scripts/aws/plan.sh
```

Example with overrides:

```bash
AWS_REGION=us-east-1 \
HOSTED_ZONE_NAME=example.com \
INSTANCE_TYPE=t4g.small \
INSTANCE_ARCH=arm64 \
SSH_KEY_NAME=your-keypair-name \
SSH_CIDR=203.0.113.10/32 \
./scripts/aws/plan.sh
```

### First Deploy Or Full Update

From repo root:

```bash
export SSH_KEY_NAME=your-keypair-name
export SSH_PRIVATE_KEY_PATH=/path/to/key.pem
export SSH_CIDR=203.0.113.10/32
export BASIC_AUTH_USERNAME=mimex
export BASIC_AUTH_PASSWORD_HASH='$2a$14$replace-with-a-caddy-compatible-hash'

./scripts/aws/release.sh
```

What `release.sh` does:

1. Builds the API and web Docker images locally with Buildx.
2. Runs Terraform apply for the EC2, networking, and DNS resources.
3. Exports them with `docker save`.
4. Uploads the images and generated Compose/Caddy configuration to the EC2 host.
5. Loads the images on the host and runs `docker compose up -d --remove-orphans`.
6. Creates a persistent random session secret on first deploy. Successful login issues a secure, HTTP-only, 30-day sliding session cookie so installed Home Screen apps do not need HTTP Basic Auth on every launch.

### Update The AWS Deployment

For normal application updates, run `./scripts/aws/release.sh` again with the same variables.

For infrastructure-only review:

```bash
./scripts/aws/plan.sh
```

### Git Workspace Sync

The AWS Compose configuration mounts a dedicated SSH directory from
`/opt/mimex/secrets/ssh` into the API container at `/root/.ssh`. Use a
write-enabled repository deploy key here rather than copying a personal SSH
key onto the server.

Periodic sync preferences are stored in each browser or desktop app. In each
client, open Settings, keep the workspace remote and branch configured, enable
periodic sync, and save. Local outbound changes are checked at the selected
interval; remote-only pulls run hourly while that client is open.

For infrastructure-only apply without rebuilding or uploading application images:

```bash
cd infra/terraform
terraform init
terraform apply \
  -var="aws_region=us-east-1" \
  -var="hosted_zone_name=mimex.dev" \
  -var="project_name=mimex" \
  -var="environment=prod" \
  -var="instance_type=t4g.small" \
  -var="instance_arch=arm64" \
  -var="root_volume_size_gb=30" \
  -var="docker_compose_version=v5.0.1" \
  -var="ssh_key_name=your-keypair-name" \
  -var="ssh_cidr=0.0.0.0/0"
```

If your deployed stack uses different values, replace the example values above so they match the active deployment.

### Take Down AWS

From repo root:

```bash
cd infra/terraform
terraform init
terraform destroy \
  -var="aws_region=us-east-1" \
  -var="hosted_zone_name=mimex.dev" \
  -var="project_name=mimex" \
  -var="environment=prod" \
  -var="instance_type=t4g.small" \
  -var="instance_arch=arm64" \
  -var="root_volume_size_gb=30" \
  -var="docker_compose_version=v5.0.1" \
  -var="ssh_key_name=your-keypair-name" \
  -var="ssh_cidr=0.0.0.0/0"
```

Notes:

- `terraform destroy` removes the AWS resources, including the EC2 instance and DNS record.
- The deployed host data under `/opt/mimex` goes away with the instance unless you have copied it elsewhere.
- If you tighten or change variables during normal operation, use the same values for destroy that match the active state.

## Generic Self-Hosted Deployment

If you do not want AWS, the repo supports self-hosting the API and web app directly on any machine you manage.

There is no checked-in production Compose file for generic hosting. The AWS release script generates one dynamically for EC2. Outside AWS, either run the services directly or build your own process manager or Compose file around the two services below.

### Option 1: Run The Built Node Services

Prerequisites:

- Node.js 20.x
- `pnpm`

Build:

```bash
pnpm install
pnpm build
```

Run the API:

```bash
HOST=0.0.0.0 \
PORT=8080 \
MIMEX_WORKSPACE_ROOT=/var/lib/mimex/workspaces \
pnpm --filter @mimex/api start
```

Run the web server:

```bash
HOST=0.0.0.0 \
PORT=4173 \
API_ORIGIN=http://127.0.0.1:8080 \
pnpm --filter @mimex/web start
```

Recommended production setup:

- Run both under `systemd`, `supervisord`, or another service manager
- Put a reverse proxy in front for TLS and public routing
- Persist `MIMEX_WORKSPACE_ROOT` outside the repo checkout
- For SSH-backed Git sync, mount a dedicated SSH directory into the API process user's home; the AWS release script persists it at `/opt/mimex/secrets/ssh`

Update:

```bash
git pull
pnpm install
pnpm build
```

Then restart the API and web services in your process manager.

Take down:

- Stop the API and web processes
- Remove any reverse proxy config you added
- Remove any persisted workspace data if you want a full teardown

### Option 2: Run The Docker Images Yourself

Build:

```bash
docker build -f apps/api/Dockerfile -t mimex-api .
docker build -f apps/web/Dockerfile -t mimex-web .
```

Container defaults:

- API listens on `0.0.0.0:8080`
- Web listens on `0.0.0.0:3000`
- Web defaults `API_ORIGIN` to `http://api:8080`

Minimal example with a user-defined Docker network:

```bash
docker network create mimex

docker run -d \
  --name mimex-api \
  --network mimex \
  -p 8080:8080 \
  -e MIMEX_WORKSPACE_ROOT=/var/lib/mimex/workspaces \
  -v /srv/mimex/workspaces:/var/lib/mimex/workspaces \
  mimex-api

docker run -d \
  --name mimex-web \
  --network mimex \
  -p 3000:3000 \
  -e API_ORIGIN=http://mimex-api:8080 \
  mimex-web
```

Update:

```bash
docker build -f apps/api/Dockerfile -t mimex-api .
docker build -f apps/web/Dockerfile -t mimex-web .
docker rm -f mimex-api mimex-web
```

Then start the new containers again.

Take down:

```bash
docker rm -f mimex-api mimex-web
docker network rm mimex
```

Remove the bound workspace directory if you want to delete data as well.

## Desktop Distribution

This is a local app distribution path, not a hosted deployment.

Run locally from source:

```bash
pnpm install
pnpm desktop:dev
```

Run after build preparation:

```bash
pnpm desktop:start
```

Build the Windows installer from native Windows PowerShell or `cmd`:

```bash
pnpm install
pnpm desktop:nsis
```

Update:

- Pull the latest repo changes
- Re-run `pnpm install`
- Re-run `pnpm desktop:dev`, `pnpm desktop:start`, or `pnpm desktop:nsis`

Take down:

- Stop the running desktop app
- If installed on Windows, uninstall it normally
- Remove persisted workspace data if desired

## MCP Server

This is a local stdio integration, not an HTTP deployment.

Run in dev mode:

```bash
pnpm --filter @mimex/mcp dev
```

Run built:

```bash
pnpm --filter @mimex/mcp build
node apps/mcp/dist/server.js
```

Important environment:

- `MIMEX_WORKSPACE_ROOT`
- `MIMEX_DEFAULT_USER_ID`
- `MIMEX_AUTO_COMMIT`

Update:

```bash
git pull
pnpm install
pnpm --filter @mimex/mcp build
```

Then restart the MCP client or tool that launches the server.

Take down:

- Remove the MCP server entry from the client config
- Stop any running `@mimex/mcp` process

## References

- `infra/terraform/README.md`
- `scripts/aws/plan.sh`
- `scripts/aws/release.sh`
- `BUILD.md`
- `apps/desktop/README.md`
- `docs/MCP.md`
