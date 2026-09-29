#!/bin/bash
cd /opt/solwallet
# Find files whose name contains the literal "===" and delete them
find . -maxdepth 1 -type f -name '*===*' -print -delete
git status --short