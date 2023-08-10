terraform {
  required_providers {
    kubectl = {
      source  = "gavinbunney/kubectl"
      version = ">= 1.14.0"
    }
    sops = {
      source  = "carlpett/sops"
      version = "~> 0.7.2"
    }
  }
}

provider "kubectl" {
  config_path    = "~/.kube/config"
  config_context = "docker-desktop"
}

provider "helm" {
  kubernetes {
    config_path    = "~/.kube/config"
    config_context = "docker-desktop"
  }
}

provider "sops" {}


data "sops_file" "default" {
  source_file = "secrets.enc.yaml"
}

## Resources

## NFS Server

resource "helm_release" "nfs-server-provisioner" {
  name       = "nfs-server-provisioner"
  namespace  = "kube-system"
  repository = "https://kubernetes-sigs.github.io/nfs-ganesha-server-and-external-provisioner/"
  chart      = "nfs-server-provisioner"
  version    = "1.8.0"
  values = [
    "${file("values/nfs-server-provisioner.yaml")}"
  ]
}

## NFS Data PVCs

resource "kubectl_manifest" "sourcify-repository-pvc" {
  yaml_body  = <<YAML
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: sourcify-repository
  namespace: sourcify
spec:
  accessModes:
  - ReadWriteMany
  resources:
    requests:
      storage: 10Gi
  storageClassName: nfs
  YAML
  depends_on = [helm_release.nfs-server-provisioner]
}

resource "kubectl_manifest" "sourcify-compilers-pvc" {
  yaml_body  = <<YAML
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: sourcify-compilers
  namespace: sourcify
spec:
  accessModes:
  - ReadWriteMany
  resources:
    requests:
      storage: 2Gi
  storageClassName: nfs
  YAML
  depends_on = [helm_release.nfs-server-provisioner]
}

##
## IPFS
##

resource "helm_release" "ipfs-cluster" {
  name             = "ipfs-cluster"
  namespace        = "sourcify"
  chart            = "../../charts/ipfs-cluster"
  create_namespace = true
  values = [
    "${file("values/ipfs-cluster.yaml")}"
  ]
  set {
    name  = "sharedSecret"
    value = data.sops_file.default.data["ipfs_cluster_shared_secret"]
  }
}

resource "helm_release" "ipfs-gateway" {
  name             = "ipfs-gateway"
  namespace        = "sourcify"
  chart            = "../../charts/ipfs-cluster"
  create_namespace = true
  values = [
    "${file("values/ipfs-gateway.yaml")}"
  ]
  set {
    name  = "sharedSecret"
    value = data.sops_file.default.data["ipfs_gateway_shared_secret"]
  }
}


##
## Sourcify Stack
##

resource "helm_release" "sourcify-server" {
  name             = "sourcify-server"
  namespace        = "sourcify"
  chart            = "../../charts/sourcify-server"
  create_namespace = true
  values = [
    "${file("values/sourcify-server.yaml")}"
  ]
  set {
    name  = "env.SESSION_SECRET"
    value = data.sops_file.default.data["SOURCIFY_SERVER_SESSION_SECRET"]
  }
}

resource "helm_release" "sourcify-monitor" {
  name             = "sourcify-monitor"
  namespace        = "sourcify"
  chart            = "../../charts/sourcify-monitor"
  create_namespace = true
  values = [
    "${file("values/sourcify-monitor.yaml")}"
  ]
}

resource "helm_release" "sourcify-repository" {
  name             = "sourcify-repository"
  namespace        = "sourcify"
  chart            = "../../charts/sourcify-repository"
  create_namespace = true
  values = [
    "${file("values/sourcify-repository.yaml")}"
  ]
}

resource "helm_release" "sourcify-ui" {
  name             = "sourcify-ui"
  namespace        = "sourcify"
  chart            = "../../charts/sourcify-ui"
  create_namespace = true
  values = [
    "${file("values/sourcify-ui.yaml")}"
  ]
}

resource "helm_release" "sourcify-docs" {
  name             = "sourcify-docs"
  namespace        = "sourcify"
  chart            = "../../charts/sourcify-docs"
  create_namespace = true
  values = [
    "${file("values/sourcify-docs.yaml")}"
  ]
}

resource "helm_release" "sourcify-playground" {
  name             = "sourcify-playground"
  namespace        = "sourcify"
  chart            = "../../charts/sourcify-playground"
  create_namespace = true
  values = [
    "${file("values/sourcify-playground.yaml")}"
  ]
}

##
## TODO: IPFS SYNC
##

##
## TODO: S3 SYNC
##
