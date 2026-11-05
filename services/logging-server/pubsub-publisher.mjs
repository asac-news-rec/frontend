export function createPubSubPublisher(topic) {
 if (!topic || typeof topic.publishMessage !== 'function') throw new Error('PUBSUB_TOPIC_REQUIRED');
 return {
  async publish(record) {
   const data=Buffer.from(JSON.stringify(record),'utf8');
   return topic.publishMessage({data,attributes:{event_id:record.event_id??record.impression_id,stream:record.event_id?'actions':'served'}});
  }
 };
}

export async function openPubSubPublisher({projectId,topicId}) {
 if (!projectId || !topicId) throw new Error('PUBSUB_PROJECT_AND_TOPIC_REQUIRED');
 const {PubSub}=await import('@google-cloud/pubsub');
 const client=new PubSub({projectId});
 return createPubSubPublisher(client.topic(topicId));
}
