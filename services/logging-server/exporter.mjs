export function createExporter({store,sink,afterWrite=()=>{}}){
 let lastSuccess=null,lastError=null;
 return {
  flush({force=false}={}){store.prepareExports();let completed=0;for(const job of store.exportJobs(force)){
   try{sink.put(job.object_name,job.content);afterWrite(job);
    sink.put(`manifests/${job.job_id}.json`,JSON.stringify({job_id:job.job_id,object_name:job.object_name,stream:job.stream,partition_path:job.partition_path,row_count:job.row_count,content_hash:job.content_hash,schema_version:1,prepared_at:job.created_at})+'\n');
    store.markExported(job.job_id);completed++;lastSuccess=new Date().toISOString();lastError=null;
   }catch(error){store.markExportFailed(job.job_id,error.message);lastError=error.message;}
  }return completed;},
  deleteReader(user){const jobs=store.revoke(user);for(const job of jobs){sink.remove(job.object_name);sink.remove(`manifests/${job.job_id}.json`);}store.finishDeletion(user);},
  state(){return {lastSuccess,lastError};}
 };
}
