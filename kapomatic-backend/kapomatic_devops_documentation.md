# Kapomatic Backend --- Production Server Documentation

## 1. Overview

This document describes the production setup for the **Kapomatic
Warehouse Backend API** deployed on a Contabo VPS. It includes
infrastructure architecture, deployment workflow, backup strategy, and
disaster recovery procedures.

------------------------------------------------------------------------

# 2. Infrastructure Architecture

## Server Information

  Item              Value
  ----------------- ------------------
  Provider          Contabo
  OS                Ubuntu 24.04 LTS
  Server IP         167.86.71.200
  Runtime           Node.js
  Process Manager   PM2
  Database          MongoDB
  Reverse Proxy     Nginx

## Architecture Diagram

                    Internet
                        │
                        ▼
                   ┌───────────┐
                   │   Nginx   │
                   │ Reverse   │
                   │  Proxy    │
                   └─────┬─────┘
                         │
                         ▼
                  ┌────────────┐
                  │   Node.js  │
                  │  Express   │
                  │  (PM2)     │
                  └─────┬──────┘
                        │
                        ▼
                  ┌────────────┐
                  │  MongoDB   │
                  │ localhost  │
                  └────────────┘

------------------------------------------------------------------------

# 3. Application Deployment

## Project Location

    /root/kapomatic-backend

## Install Dependencies

    npm install

## Start Application

    pm2 start src/server.js --name kapo-api

## View Running Processes

    pm2 list

## Restart Application

    pm2 restart kapo-api

## Logs

    pm2 logs kapo-api

------------------------------------------------------------------------

# 4. MongoDB Configuration

## Config File

    /etc/mongod.conf

### Security

    security:
      authorization: enabled

### Network Binding

    bindIp: 127.0.0.1

MongoDB is accessible only from inside the server.

------------------------------------------------------------------------

# 5. MongoDB Users

## Admin User

Database:

    admin

User:

    admin

Password:

    123

Role:

    root

Command:

    use admin

    db.createUser({
     user: "admin",
     pwd: "123",
     roles: [{ role: "root", db: "admin" }]
    })

------------------------------------------------------------------------

## Application User

Database:

    kapoInventory

User:

    appuser

Password:

    123

Role:

    readWrite

Command:

    use kapoInventory

    db.createUser({
     user: "appuser",
     pwd: "123",
     roles: [{ role: "readWrite", db: "kapoInventory" }]
    })

------------------------------------------------------------------------

# 6. Database Connection String

    mongodb://appuser:123@127.0.0.1:27017/kapoInventory?authSource=kapoInventory

------------------------------------------------------------------------

# 7. API Endpoints

Base URL

    http://167.86.71.200/api/

Example

    http://167.86.71.200/api/categories

------------------------------------------------------------------------

# 8. Deployment Workflow

Typical update workflow:

1.  Developer pushes code to Git repository
2.  Connect to server via SSH
3.  Navigate to project directory
4.  Pull latest code
5.  Restart PM2

Commands:

    cd /root/kapomatic-backend

    git pull

    pm2 restart kapo-api

------------------------------------------------------------------------

# 9. Backup Strategy

Automated backups include:

-   MongoDB database
-   Backend project files

## Backup Script

Location

    /root/backup.sh

## Backup Directory

    /root/backups

Example Files

    mongo-YYYY-MM-DD.tar.gz
    project-YYYY-MM-DD.tar.gz

------------------------------------------------------------------------

# 10. Automated Backup (Cron)

Cron configuration:

    crontab -e

Task:

    0 3 * * * /root/backup.sh >> /var/log/backup.log 2>&1

Backup runs every day at **03:00 AM**.

------------------------------------------------------------------------

# 11. Disaster Recovery Guide

If the server fails or data is lost:

1.  Provision new VPS
2.  Install Node.js, MongoDB, PM2
3.  Restore database backup
4.  Restore project files
5.  Start application using PM2

------------------------------------------------------------------------

# 12. Restore Backup Guide

## Restore MongoDB

    mkdir restore_tmp

    tar -xzf mongo-YYYY-MM-DD.tar.gz -C restore_tmp

    mongorestore --uri="mongodb://admin:123@127.0.0.1:27017/admin" --drop restore_tmp/mongo

------------------------------------------------------------------------

## Restore Project

    tar -xzf project-YYYY-MM-DD.tar.gz -C /root

    cd /root/kapomatic-backend

    npm install

    <!-- pm2 restart kapo-api -->
    
    pm2 restart kapo-api --update-env

------------------------------------------------------------------------

# 13. Security Recommendations

Recommended improvements:

-   Change default MongoDB passwords
-   Use environment variables instead of hardcoded credentials
-   Enable HTTPS using Nginx + Let's Encrypt
-   Store backups externally (Google Drive / S3)
-   Implement firewall rules

------------------------------------------------------------------------

# 14. Production Checklist

  Item                      Status
  ------------------------- -------------
  Node API running          ✅
  MongoDB authentication    ✅
  PM2 process manager       ✅
  Daily backup system       ✅
  Git deployment workflow   ✅
  Reverse proxy (Nginx)     Recommended
  SSL                       Recommended

------------------------------------------------------------------------

# End of Document
