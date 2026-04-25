public with sharing class SubmissionTemplateController {
    // ─────────────────────────────────────────────────────────────────────────
    // Wrapper class for active job stage configuration (The Canvas)
    // ─────────────────────────────────────────────────────────────────────────
    public class StageWrapper {
        @AuraEnabled public String stageKey; // REQUIRED: Tells the DB which component this is!
        @AuraEnabled public Integer stageIndex;
        @AuraEnabled public Boolean isRequired;
        @AuraEnabled public Boolean isActive;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Wrapper class for metadata configuration (The Palette)
    // ─────────────────────────────────────────────────────────────────────────
    public class ConfigWrapper {
        @AuraEnabled public String stageKey; // Maps to the CMDT DeveloperName
        @AuraEnabled public String label;
        @AuraEnabled public String iconName;
        @AuraEnabled public Boolean isDefaultRequired;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Get all available stage configs from Custom Metadata (The Palette)
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled(cacheable=true)
    public static List<ConfigWrapper> getAllStageConfigs() {
        List<ConfigWrapper> results = new List<ConfigWrapper>();

        // We MUST query DeveloperName so the UI knows the unique ID of the component
        List<Candidate_Stage_Config__mdt> configs = [
            SELECT DeveloperName, Stage_Label__c, Icon_Name__c, Is_Default_Required__c
            FROM Candidate_Stage_Config__mdt
            ORDER BY Stage_Label__c ASC
        ];

        for (Candidate_Stage_Config__mdt c : configs) {
            ConfigWrapper w = new ConfigWrapper();
            w.stageKey          = c.DeveloperName; // Dynamic Registry Key
            w.label             = c.Stage_Label__c;
            w.iconName          = c.Icon_Name__c;
            w.isDefaultRequired = (c.Is_Default_Required__c == true); 
            results.add(w);
        }

        return results;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Get submission template configuration for a Job (The Canvas)
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
            w.stageKey   = t.Stage_Key__c; // Read the saved key
            w.stageIndex = Integer.valueOf(t.Stage_Index__c);
            w.isRequired = t.Is_Required__c;
            w.isActive   = t.Is_Active__c;
            result.add(w);
        }

        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Save/Update submission template configuration for a Job
    // ─────────────────────────────────────────────────────────────────────────
    @AuraEnabled
    public static void saveSubmissionTemplate(Id jobId, String stagesJson) {
        if (jobId == null) throw new AuraHandledException('Job ID is required.');
        if (String.isBlank(stagesJson)) throw new AuraHandledException('Stage configuration is required.');

        try {
            List<StageWrapper> stages = (List<StageWrapper>) JSON.deserialize(stagesJson, List<StageWrapper>.class);

            // Delete existing template records for this job
            List<Candidate_Submission__c> existing = [
                SELECT Id FROM Candidate_Submission__c
                WHERE Job__c = :jobId AND RecordType.DeveloperName = 'Submission_Template'
            ];

            if (!existing.isEmpty()) {
                delete existing;
            }

            Id rtId = Schema.SObjectType.Candidate_Submission__c
                .getRecordTypeInfosByDeveloperName().get('Submission_Template').getRecordTypeId();

            List<Candidate_Submission__c> toInsert = new List<Candidate_Submission__c>();

            for (StageWrapper w : stages) {
                toInsert.add(new Candidate_Submission__c(
                    Job__c         = jobId,
                    RecordTypeId   = rtId,
                    Stage_Key__c   = w.stageKey, // WE MUST SAVE THIS FIELD!
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