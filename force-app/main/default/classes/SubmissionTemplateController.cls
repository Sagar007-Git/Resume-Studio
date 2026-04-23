public with sharing class SubmissionTemplateController {

    // ─────────────────────────────────────────────────────────────────────────
    // Wrapper class for stage configuration
    // ─────────────────────────────────────────────────────────────────────────
    public class StageWrapper {
        @AuraEnabled public String stageKey;
        @AuraEnabled public Integer stageIndex;
        @AuraEnabled public Boolean isRequired;
        @AuraEnabled public Boolean isActive;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Get submission template configuration for a Job
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled(cacheable=false)
    public static List<StageWrapper> getSubmissionTemplate(Id jobId) {
        List<StageWrapper> result = new List<StageWrapper>();

        if (jobId == null) {
            throw new AuraHandledException('Job ID is required.');
        }

        List<Candidate_Submission__c> templates = [
            SELECT Stage_Key__c, Stage_Index__c, Is_Required__c, Is_Active__c
            FROM Candidate_Submission__c
            WHERE Job__c = :jobId
              AND RecordType.DeveloperName = 'Submission_Template'
            ORDER BY Stage_Index__c ASC
        ];

        for (Candidate_Submission__c t : templates) {
            StageWrapper w = new StageWrapper();
            w.stageKey   = t.Stage_Key__c;
            w.stageIndex = Integer.valueOf(t.Stage_Index__c);
            w.isRequired = t.Is_Required__c;
            w.isActive   = t.Is_Active__c;
            result.add(w);
        }

        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Save/Update submission template configuration for a Job
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static void saveSubmissionTemplate(Id jobId, String stagesJson) {
        if (jobId == null) {
            throw new AuraHandledException('Job ID is required.');
        }

        if (String.isBlank(stagesJson)) {
            throw new AuraHandledException('Stage configuration is required.');
        }

        try {
            // Parse incoming stage data using typed deserialization
            List<StageWrapper> stages = (List<StageWrapper>)
                JSON.deserialize(stagesJson, List<StageWrapper>.class);

            // Delete existing template records for this job
            List<Candidate_Submission__c> existing = [
                SELECT Id
                FROM Candidate_Submission__c
                WHERE Job__c = :jobId
                  AND RecordType.DeveloperName = 'Submission_Template'
            ];

            if (!existing.isEmpty()) {
                delete existing;
            }

            // Get the Submission Template record type Id
            Id rtId = Schema.SObjectType.Candidate_Submission__c
                .getRecordTypeInfosByDeveloperName()
                .get('Submission_Template')
                .getRecordTypeId();

            // Insert new template records
            List<Candidate_Submission__c> toInsert = new List<Candidate_Submission__c>();

            for (StageWrapper w : stages) {
                toInsert.add(new Candidate_Submission__c(
                    Job__c         = jobId,
                    RecordTypeId   = rtId,
                    Stage_Key__c   = w.stageKey,
                    Stage_Index__c = w.stageIndex,
                    Is_Required__c = w.isRequired,
                    Is_Active__c   = w.isActive
                ));
            }

            if (!toInsert.isEmpty()) {
                insert toInsert;
            }

        } catch (Exception e) {
            throw new AuraHandledException('Failed to save template: ' + e.getMessage());
        }
    }
}